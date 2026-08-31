import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const mcpUrl = required("MCP_URL");
const mcpAccessToken = required("MCP_ACCESS_TOKEN");
const cptrBaseUrl = required("CPTR_BASE_URL").replace(/\/$/, "");
const cptrAdminCookie = required("CPTR_ADMIN_COOKIE");
const failureMcpUrl = process.env.MCP_FAILURE_URL?.trim() || null;
const failureMcpAccessToken = process.env.MCP_FAILURE_ACCESS_TOKEN?.trim() || null;
const timeoutMs = Math.max(2_000, Math.min(30_000, Number(process.env.MCP_TRAFFIC_ACCEPTANCE_TIMEOUT_MS ?? "10000") || 10_000));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, description, deadlineMs = timeoutMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

async function connectClient(name, url = mcpUrl, token = mcpAccessToken) {
  const client = new Client({ name, version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: authHeaders(token) },
  });
  await client.connect(transport);
  return { client, transport };
}

async function getSnapshot() {
  const response = await fetch(`${cptrBaseUrl}/api/mcp/traffic/snapshot`, {
    headers: { Cookie: cptrAdminCookie, Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`snapshot failed with HTTP ${response.status}`);
  return response.json();
}

async function openTrafficStream() {
  const controller = new AbortController();
  const frames = [];
  const response = await fetch(`${cptrBaseUrl}/api/mcp/traffic/stream`, {
    headers: { Cookie: cptrAdminCookie, Accept: "text/event-stream" },
    signal: controller.signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`traffic stream failed with HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const readerTask = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
          if (!block || block.startsWith(":")) continue;
          let event = "message";
          const dataLines = [];
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
          }
          if (!dataLines.length) continue;
          try {
            frames.push({ event, data: JSON.parse(dataLines.join("\n")) });
          } catch {
            // Ignore malformed/non-JSON frames; CPTR traffic frames are JSON.
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  })();

  return {
    frames,
    async close() {
      controller.abort();
      await reader.cancel().catch(() => undefined);
      await readerTask.catch(() => undefined);
    },
  };
}

function trafficEvents(frames) {
  return frames.filter((frame) => frame.event === "traffic").map((frame) => frame.data);
}

function assertSafeTelemetry(snapshot, events) {
  const encoded = JSON.stringify({ snapshot, events });
  assert.doesNotMatch(encoded, /"(?:authorization|cookie|arguments|result|prompt|api[_-]?key|token)"\s*:/i);
  assert.doesNotMatch(encoded, /\bBearer\s+[A-Za-z0-9._~+/=-]+/i);
}

async function verifyFailureIsolation() {
  if (!failureMcpUrl && !failureMcpAccessToken) return "skipped (failure plugin not configured)";
  assert.ok(failureMcpUrl && failureMcpAccessToken, "MCP_FAILURE_URL and MCP_FAILURE_ACCESS_TOKEN must be set together");
  const { client, transport } = await connectClient("Telemetry Failure Acceptance", failureMcpUrl, failureMcpAccessToken);
  try {
    await client.listTools();
    const result = await client.callTool({ name: "cptr_list_workspaces", arguments: {} });
    assert.notEqual(result.isError, true, "MCP tool call must succeed when telemetry ingestion is rejected");
  } finally {
    await transport.terminateSession().catch(() => undefined);
    await client.close().catch(() => undefined);
  }
  return "passed";
}

const stream = await openTrafficStream();
let chatgpt;
let gemini;
try {
  await waitFor(() => stream.frames.some((frame) => frame.event === "snapshot"), "initial traffic snapshot");

  chatgpt = await connectClient("ChatGPT Acceptance");
  gemini = await connectClient("Gemini Acceptance");

  const [chatgptTools, geminiTools] = await Promise.all([
    chatgpt.client.listTools(),
    gemini.client.listTools(),
  ]);
  assert.ok(chatgptTools.tools.some((tool) => tool.name === "cptr_list_workspaces"));
  assert.ok(geminiTools.tools.some((tool) => tool.name === "cptr_list_workspaces"));

  const call = await chatgpt.client.callTool({ name: "cptr_list_workspaces", arguments: {} });
  assert.notEqual(call.isError, true);

  await waitFor(
    () => trafficEvents(stream.frames).some((event) => event.event_type === "tool_finished" && event.tool_name === "cptr_list_workspaces"),
    "tool completion telemetry",
  );

  const snapshot = await getSnapshot();
  assert.ok(snapshot.clients.some((client) => client.label === "ChatGPT"), "snapshot must contain ChatGPT client");
  assert.ok(snapshot.clients.some((client) => client.label === "Gemini"), "snapshot must contain Gemini client");

  const events = trafficEvents(stream.frames);
  assert.ok(events.some((event) => event.event_type === "session_opened" && event.client?.label === "ChatGPT"));
  assert.ok(events.some((event) => event.event_type === "session_opened" && event.client?.label === "Gemini"));
  assert.ok(events.some((event) => event.event_type === "request_started"));
  assert.ok(events.some((event) => event.event_type === "tool_started"));

  const toolStartIndex = events.findIndex(
    (event) => event.event_type === "tool_started" && event.tool_name === "cptr_list_workspaces" && event.client?.label === "ChatGPT",
  );
  assert.ok(toolStartIndex >= 0, "ChatGPT tool_started event must be present");
  const requestId = events[toolStartIndex].request_id;
  const requestStartIndex = events.findIndex(
    (event) => event.event_type === "request_started" && event.request_id === requestId,
  );
  const toolFinishIndex = events.findIndex(
    (event) => event.event_type === "tool_finished" && event.request_id === requestId,
  );
  const requestFinishIndex = events.findIndex(
    (event) => event.event_type === "request_finished" && event.request_id === requestId,
  );
  assert.ok(requestStartIndex >= 0 && requestStartIndex < toolStartIndex, "request_started must precede tool_started");
  assert.ok(toolFinishIndex > toolStartIndex, "tool_finished must follow tool_started");
  assert.ok(requestFinishIndex > toolFinishIndex, "request_finished must follow tool_finished");

  assertSafeTelemetry(snapshot, events);

  await Promise.all([
    chatgpt.transport.terminateSession(),
    gemini.transport.terminateSession(),
  ]);
  await Promise.all([
    chatgpt.client.close(),
    gemini.client.close(),
  ]);
  chatgpt = undefined;
  gemini = undefined;

  await waitFor(
    () => {
      const closed = trafficEvents(stream.frames).filter((event) => event.event_type === "session_closed");
      return closed.some((event) => event.client?.label === "ChatGPT") && closed.some((event) => event.client?.label === "Gemini");
    },
    "session close telemetry",
  );

  const failureIsolation = await verifyFailureIsolation();
  console.log(JSON.stringify({
    ok: true,
    clients: ["ChatGPT", "Gemini"],
    request_tool_ordering: "passed",
    telemetry_secret_absence: "passed",
    session_close: "passed",
    failure_isolation: failureIsolation,
    observed_traffic_events: trafficEvents(stream.frames).length,
  }, null, 2));
} finally {
  await chatgpt?.transport.terminateSession().catch(() => undefined);
  await gemini?.transport.terminateSession().catch(() => undefined);
  await chatgpt?.client.close().catch(() => undefined);
  await gemini?.client.close().catch(() => undefined);
  await stream.close();
}
