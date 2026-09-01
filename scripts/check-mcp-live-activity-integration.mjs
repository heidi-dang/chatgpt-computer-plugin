import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const host = "127.0.0.1";
const timeoutMs = Math.max(
  5_000,
  Math.min(60_000, Number(process.env.MCP_LIVE_ACTIVITY_ACCEPTANCE_TIMEOUT_MS ?? "20000") || 20_000),
);
const toolName = "cptr_list_workspaces";
const secretSentinel = `activity-secret-${randomUUID()}`;
const controlToken = `${secretSentinel}-control`;
const failureControlToken = `${secretSentinel}-failure-control`;
const mcpToken = `${secretSentinel}-mcp`;
const failureMcpToken = `${secretSentinel}-failure-mcp`;
const adminCookie = `cptr-live-activity=${randomUUID()}`;
const children = [];

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function readJsonBody(req, maxBytes = 2_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        reject(new Error("acceptance request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function writeJson(res, status, value) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
}

function bearer(req) {
  const value = req.headers.authorization;
  return typeof value === "string" && value.startsWith("Bearer ") ? value.slice(7) : null;
}

function hasAdminCookie(req) {
  return String(req.headers.cookie ?? "") === adminCookie;
}

async function createCptrHarness() {
  const successTraffic = [];
  const successActivity = [];
  const successDiagnostics = [];
  const failureTraffic = [];
  const failureDiagnostics = [];
  let failureActivityAttempts = 0;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}`);
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        writeJson(res, 200, { status: "ok" });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/control/v1/workspaces") {
        const token = bearer(req);
        if (token !== controlToken && token !== failureControlToken) {
          writeJson(res, 403, { error: "forbidden" });
          return;
        }
        writeJson(res, 200, { workspaces: [] });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/mcp/traffic/events") {
        const token = bearer(req);
        if (token !== controlToken && token !== failureControlToken) {
          writeJson(res, 403, { error: "forbidden" });
          return;
        }
        const payload = await readJsonBody(req);
        const events = Array.isArray(payload.events) ? payload.events : [];
        const destination = token === controlToken ? successTraffic : failureTraffic;
        destination.push(...events.map((event) => structuredClone(event)));
        writeJson(res, 200, { accepted: events.length, duplicates: 0, dropped: 0 });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/mcp/diagnostics/events") {
        const token = bearer(req);
        if (token !== controlToken && token !== failureControlToken) {
          writeJson(res, 403, { error: "forbidden" });
          return;
        }
        const payload = await readJsonBody(req);
        const events = Array.isArray(payload.events) ? payload.events : [];
        const destination = token === controlToken ? successDiagnostics : failureDiagnostics;
        destination.push(...events.map((event) => structuredClone(event)));
        writeJson(res, 200, { accepted: events.length, duplicates: 0, dropped: 0 });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/mcp/activity/events") {
        const token = bearer(req);
        if (token === failureControlToken) {
          failureActivityAttempts += 1;
          writeJson(res, 503, { error: "activity ingestion unavailable" });
          return;
        }
        if (token !== controlToken) {
          writeJson(res, 403, { error: "forbidden" });
          return;
        }
        const payload = await readJsonBody(req);
        const events = Array.isArray(payload.events) ? payload.events : [];
        successActivity.push(...events.map((event) => structuredClone(event)));
        writeJson(res, 200, { accepted: events.length, duplicates: 0, dropped: 0 });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/mcp/traffic/snapshot") {
        if (!hasAdminCookie(req)) {
          writeJson(res, 401, { error: "admin cookie required" });
          return;
        }
        writeJson(res, 200, { version: 1, events: successTraffic });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/mcp/activity/snapshot") {
        if (!hasAdminCookie(req)) {
          writeJson(res, 401, { error: "admin cookie required" });
          return;
        }
        writeJson(res, 200, { version: 1, events: successActivity });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/mcp/diagnostics/snapshot") {
        if (!hasAdminCookie(req)) {
          writeJson(res, 401, { error: "admin cookie required" });
          return;
        }
        writeJson(res, 200, { version: 1, events: successDiagnostics });
        return;
      }

      writeJson(res, 404, { error: "not found" });
    } catch {
      if (!res.headersSent) writeJson(res, 500, { error: "harness failure" });
      else res.end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  assert.ok(typeof address === "object" && address, "CPTR harness must bind a port");

  return {
    baseUrl: `http://${host}:${address.port}`,
    server,
    successTraffic,
    successActivity,
    successDiagnostics,
    failureTraffic,
    failureDiagnostics,
    get failureActivityAttempts() {
      return failureActivityAttempts;
    },
  };
}

function spawnPlugin({ port, cptrBaseUrl, token, apiToken }) {
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: host,
      PORT: String(port),
      PUBLIC_ORIGIN: `http://${host}:${port}`,
      CPTR_BASE_URL: cptrBaseUrl,
      CPTR_API_TOKEN: apiToken,
      MCP_ACCESS_TOKEN: token,
      NODE_ENV: "development",
      CPTR_NOTIFY_TOOL_LIST_CHANGED: "0",
      CPTR_MCP_TRAFFIC_PLUGIN_FLUSH_MS: "25",
      CPTR_MCP_ACTIVITY_PLUGIN_FLUSH_MS: "25",
      CPTR_MCP_DIAGNOSTICS_PLUGIN_FLUSH_MS: "25",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  const collect = (channel) => (chunk) => {
    output.push(`${channel}: ${String(chunk)}`);
    while (output.join("").length > 30_000 && output.length > 1) output.shift();
  };
  child.stdout.on("data", collect("stdout"));
  child.stderr.on("data", collect("stderr"));
  children.push({ child, output });
  return { child, output };
}

async function waitForHttp(url) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not started";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for plugin: ${lastError}`);
}

async function waitFor(predicate, description) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function connectClient(url, token, name) {
  const client = new Client({ name, version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return { client, transport };
}

async function snapshot(baseUrl, path) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Cookie: adminCookie, Accept: "application/json" },
  });
  assert.equal(response.status, 200, `${path} must be readable by the disposable admin`);
  return response.json();
}

function assertTrafficMetadataOnly(events) {
  for (const event of events) {
    for (const forbidden of ["arguments_json", "result_json", "error_json", "arguments", "result", "prompt"]) {
      assert.equal(Object.hasOwn(event, forbidden), false, `traffic must not contain ${forbidden}`);
    }
  }
  const encoded = JSON.stringify(events);
  assert.equal(encoded.includes(secretSentinel), false, "traffic must not contain credential sentinel");
  assert.doesNotMatch(encoded, /\bBearer\s+[A-Za-z0-9._~+/=-]+/i);
}

function assertActivitySecretAbsence(events) {
  const encoded = JSON.stringify(events);
  assert.equal(encoded.includes(secretSentinel), false, "activity must not contain credential sentinel");
  assert.equal(encoded.includes(controlToken), false);
  assert.equal(encoded.includes(mcpToken), false);
  assert.doesNotMatch(encoded, /\bBearer\s+[A-Za-z0-9._~+/=-]+/i);
}

function assertDiagnosticsSafe(events) {
  const encoded = JSON.stringify(events);
  assert.equal(encoded.includes(secretSentinel), false, "diagnostics must not contain credential sentinel");
  assert.equal(encoded.includes(controlToken), false);
  assert.equal(encoded.includes(mcpToken), false);
  assert.doesNotMatch(encoded, /\bBearer\s+[A-Za-z0-9._~+/=-]+/i);
  for (const event of events) {
    for (const forbidden of ["arguments_json", "result_json", "error_json", "headers", "authorization", "stack"]) {
      assert.equal(Object.hasOwn(event, forbidden), false, `diagnostics must not contain ${forbidden}`);
    }
  }
}

async function stopChildren() {
  await Promise.all(
    children.map(async ({ child }) => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }),
  );
}

const harness = await createCptrHarness();
const [pluginPort, failurePluginPort] = await Promise.all([reservePort(), reservePort()]);
assert.ok(pluginPort && failurePluginPort);
const successPlugin = spawnPlugin({
  port: pluginPort,
  cptrBaseUrl: harness.baseUrl,
  token: mcpToken,
  apiToken: controlToken,
});
const failurePlugin = spawnPlugin({
  port: failurePluginPort,
  cptrBaseUrl: harness.baseUrl,
  token: failureMcpToken,
  apiToken: failureControlToken,
});

let successClient;
let failureClient;
try {
  await Promise.all([
    waitForHttp(`http://${host}:${pluginPort}/plugin/update`),
    waitForHttp(`http://${host}:${failurePluginPort}/plugin/update`),
  ]);

  successClient = await connectClient(
    `http://${host}:${pluginPort}/mcp`,
    mcpToken,
    "ChatGPT Acceptance",
  );
  const listed = await successClient.client.listTools();
  assert.ok(listed.tools.some((tool) => tool.name === toolName), `${toolName} must be registered`);

  const call = await successClient.client.callTool({
    name: toolName,
    arguments: { include_unavailable: false, client_model: "GPT-5.6 Sol" },
  });
  assert.notEqual(call.isError, true, "real MCP tool call must succeed");

  await waitFor(
    () => harness.successActivity.some((event) => event.tool_name === toolName && event.phase === "complete"),
    "Activity tool completion",
  );
  await waitFor(
    () => harness.successTraffic.some((event) => event.tool_name === toolName && event.event_type === "tool_finished"),
    "traffic tool completion",
  );
  await waitFor(
    () =>
      harness.successDiagnostics.some(
        (event) => event.kind === "latency" && event.edge_id === "cptr-mcp-cptr-backend",
      ),
    "backend RTT diagnostic",
  );

  const trafficSnapshot = await snapshot(harness.baseUrl, "/api/mcp/traffic/snapshot");
  const activitySnapshot = await snapshot(harness.baseUrl, "/api/mcp/activity/snapshot");
  const diagnosticsSnapshot = await snapshot(harness.baseUrl, "/api/mcp/diagnostics/snapshot");
  const traffic = trafficSnapshot.events;
  const activity = activitySnapshot.events;
  const diagnostics = diagnosticsSnapshot.events;

  const toolStart = traffic.find(
    (event) => event.event_type === "tool_started" && event.tool_name === toolName && event.client?.label === "ChatGPT",
  );
  assert.ok(toolStart, "traffic must contain ChatGPT tool_started");
  assert.equal(typeof toolStart.correlation_id, "string");
  assert.ok(toolStart.correlation_id.length > 0);
  assert.ok(
    traffic.some(
      (event) =>
        event.request_id === toolStart.request_id &&
        (event.event_type === "request_started" || event.method === "tools/call"),
    ),
    "traffic must contain the correlated request lifecycle",
  );

  const started = activity.find(
    (event) =>
      event.request_id === toolStart.request_id && event.tool_name === toolName && event.phase === "started",
  );
  const complete = activity.find(
    (event) =>
      event.request_id === toolStart.request_id && event.tool_name === toolName && event.phase === "complete",
  );
  assert.ok(started, "Activity must contain correlated started record");
  assert.ok(complete, "Activity must contain correlated complete record");
  assert.equal(started.correlation_id, toolStart.correlation_id);
  assert.equal(complete.correlation_id, toolStart.correlation_id);
  const correlatedDiagnostics = diagnostics.filter(
    (event) => event.request_id === toolStart.request_id && event.correlation_id === toolStart.correlation_id,
  );
  const observedEdges = new Map(
    correlatedDiagnostics
      .filter((event) => event.kind === "latency")
      .map((event) => [event.edge_id, event.metric_type]),
  );
  assert.equal(observedEdges.get("client-mcp-connector"), "observed_request_time");
  assert.equal(observedEdges.get("mcp-connector-cptr-mcp"), "adapter_handoff");
  assert.equal(observedEdges.get("cptr-mcp-cptr-backend"), "backend_api_rtt");
  const usage = correlatedDiagnostics.filter(
    (event) => event.kind === "usage" && event.tool_name === toolName,
  );
  assert.equal(usage.length, 1, "the correlated tool call must emit exactly one Usage diagnostic");
  assert.equal(usage[0].model_reported, "GPT-5.6 Sol");
  assert.equal(usage[0].model_canonical, "gpt-5.6-sol");
  assert.equal(usage[0].model_source, "self_reported");
  assert.ok(usage[0].input_tokens_estimated > 0);
  assert.ok(usage[0].output_tokens_estimated > 0);
  assert.equal(usage[0].cached_input_tokens_estimated, null);
  assert.equal(usage[0].status, "complete");
  assert.equal(started.client?.label, "ChatGPT");
  assert.equal(typeof started.arguments_json, "string");
  assert.ok(started.arguments_json.length > 0 && started.arguments_json.length <= 13_000);
  assert.match(started.arguments_json, /include_unavailable/);
  assert.doesNotMatch(started.arguments_json, /client_model/);
  assert.equal(started.result_json, null);
  assert.equal(typeof complete.result_json, "string");
  assert.ok(complete.result_json.length > 0 && complete.result_json.length <= 13_000);
  assert.equal(complete.error_json, null);
  assert.ok((complete.duration_ms ?? -1) >= 0);

  assertTrafficMetadataOnly(traffic);
  assertActivitySecretAbsence(activity);
  assertDiagnosticsSafe(diagnostics);

  await successClient.transport.terminateSession();
  await successClient.client.close();
  successClient = undefined;
  await waitFor(
    () =>
      harness.successTraffic.some(
        (event) => event.event_type === "session_closed" && event.client?.label === "ChatGPT",
      ),
    "ChatGPT session close traffic",
  );

  failureClient = await connectClient(
    `http://${host}:${failurePluginPort}/mcp`,
    failureMcpToken,
    "ChatGPT Activity Failure Acceptance",
  );
  const failureCall = await failureClient.client.callTool({
    name: toolName,
    arguments: { client_model: "GPT-5.6 Sol" },
  });
  assert.notEqual(
    failureCall.isError,
    true,
    "Activity delivery rejection must never fail the real MCP tool call",
  );
  await waitFor(() => harness.failureActivityAttempts > 0, "rejected Activity delivery attempt");
  await waitFor(
    () => harness.failureTraffic.some((event) => event.event_type === "tool_finished" && event.tool_name === toolName),
    "healthy traffic delivery on Activity failure path",
  );
  await waitFor(
    () =>
      harness.failureDiagnostics.some(
        (event) => event.kind === "failure" && event.stage === "activity_delivery",
      ),
    "activity delivery diagnostic",
  );
  const activityDeliveryFailure = harness.failureDiagnostics.find(
    (event) => event.kind === "failure" && event.stage === "activity_delivery",
  );
  assert.equal(activityDeliveryFailure.error_code, "telemetry_delivery_failed");
  assert.equal(activityDeliveryFailure.retryable, true);
  assertDiagnosticsSafe(harness.failureDiagnostics);
  await failureClient.transport.terminateSession().catch(() => undefined);
  await failureClient.client.close().catch(() => undefined);
  failureClient = undefined;

  console.log(
    JSON.stringify(
      {
        ok: true,
        client: "ChatGPT",
        tool: toolName,
        correlated_request: "passed",
        traffic_metadata_only: "passed",
        activity_started_complete: "passed",
        activity_payload_bounds: "passed",
        credential_secret_absence: "passed",
        session_close: "passed",
        activity_failure_isolation: "passed",
        diagnostics_correlation: "passed",
        truthful_latency_edges: "passed",
        diagnostics_secret_absence: "passed",
        usage_model_self_report: "passed",
        usage_token_estimation: "passed",
        activity_delivery_diagnostic: "passed",
        observed: {
          traffic_events: traffic.length,
          activity_events: activity.length,
          diagnostic_events: diagnostics.length,
          failure_diagnostic_events: harness.failureDiagnostics.length,
          rejected_activity_batches: harness.failureActivityAttempts,
        },
      },
      null,
      2,
    ),
  );
} catch (error) {
  const childDiagnostics = [successPlugin, failurePlugin]
    .map(({ child, output }, index) => {
      if (child.exitCode === null && output.length === 0) return null;
      return `plugin-${index + 1} exit=${child.exitCode ?? "running"}\n${output.join("").slice(-8_000)}`;
    })
    .filter(Boolean)
    .join("\n");
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(childDiagnostics ? `${message}\n${childDiagnostics}` : message);
} finally {
  await successClient?.transport.terminateSession().catch(() => undefined);
  await successClient?.client.close().catch(() => undefined);
  await failureClient?.transport.terminateSession().catch(() => undefined);
  await failureClient?.client.close().catch(() => undefined);
  await stopChildren();
  await new Promise((resolve) => harness.server.close(resolve));
}
