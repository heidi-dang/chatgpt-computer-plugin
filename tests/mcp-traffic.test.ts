import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { ComputerClient } from "../server/client/computer-client.js";
import {
  McpTrafficEmitter,
  enrichMcpClientSession,
  mcpRequestContext,
  normalizeMcpClient,
  normalizeTrafficErrorCode,
  type McpRequestContextValue,
  type McpTrafficEvent,
} from "../server/mcp-traffic.js";
import { createMcpServer } from "../server/mcp.js";

test("MCP traffic normalizes the active ChatGPT client and bounds unknown labels", () => {
  assert.deepEqual(normalizeMcpClient({ name: "ChatGPT", version: "1" }), {
    id: "chatgpt",
    label: "ChatGPT",
    version: "1",
    session_name: null,
    model: null,
    workspace_id: null,
    workspace_name: null,
  });
  assert.equal(normalizeMcpClient({ name: "x".repeat(200) }).label.length, 80);
  assert.equal(normalizeMcpClient(undefined).label, "Unknown MCP Client");
});

test("MCP traffic emits only the active ChatGPT client identity", async () => {
  const delivered: McpTrafficEvent[][] = [];
  const emitter = new McpTrafficEmitter({
    env: {
      CPTR_MCP_TRAFFIC_PLUGIN_BATCH_SIZE: "10",
      CPTR_MCP_TRAFFIC_PLUGIN_FLUSH_MS: "10000",
    },
    deliver: async (events) => {
      delivered.push(events);
    },
  });

  emitter.sessionOpened(
    "session-unsupported",
    normalizeMcpClient({ name: "Foreign MCP Client" }),
  );
  await emitter.flush();
  await emitter.close();

  assert.deepEqual(delivered, []);
});

test("MCP traffic enriches ChatGPT transport sessions with truthful model, workspace, and session identity", () => {
  const enriched = enrichMcpClientSession(
    normalizeMcpClient({ name: "ChatGPT", version: "1" }),
    {
      sessionId: "9dc95a95-9cf1-4b9b-a417-aa0300aee123",
      sessionName: "MCP topology identity + 10 recent requests",
      model: "GPT-5.6 Sol",
      workspaceId: "workspace-123",
      workspaceName: "Desktop",
    },
  );

  assert.equal(
    enriched.id,
    "chatgpt-session-9dc95a95-9cf1-4b9b-a417-aa0300aee123",
  );
  assert.equal(
    enriched.label,
    "ChatGPT · MCP topology identity + 10 recent requests",
  );
  assert.equal(
    enriched.session_name,
    "MCP topology identity + 10 recent requests",
  );
  assert.equal(enriched.model, "GPT-5.6 Sol");
  assert.equal(enriched.workspace_id, "workspace-123");
  assert.equal(enriched.workspace_name, "Desktop");
});

test("MCP tool wrapper emits the enriched ChatGPT session identity", async () => {
  const delivered: McpTrafficEvent[][] = [];
  const emitter = new McpTrafficEmitter({
    env: {
      CPTR_MCP_TRAFFIC_PLUGIN_BATCH_SIZE: "10",
      CPTR_MCP_TRAFFIC_PLUGIN_FLUSH_MS: "10000",
    },
    deliver: async (events) => {
      delivered.push(events);
    },
  });
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url.includes("/workspaces?include_unavailable=false")) {
        return new Response(
          JSON.stringify({
            workspaces: [
              {
                workspace_id: "workspace-123",
                name: "Desktop",
                available: true,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/workbench-sessions") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            session_id: "wbs_session_00000001",
            name: "MCP topology identity",
            workspace_id: "workspace-123",
            status: "OPEN",
            active_target_type: null,
            active_target_id: null,
            active_workspace_id: null,
            event_count: 0,
            created_at: 1,
            updated_at: 1,
            last_event_at: null,
            archived_at: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const server = createMcpServer(computer, { traffic: emitter });
  const sdkClient = new Client({ name: "ChatGPT", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    sdkClient.connect(clientTransport),
  ]);

  /* @mcp-codemod-error This object looks like a v1 handler-context mock (requestId, sessionId). v2 nests the context — reshape it (requestId → mcpReq.id; sessionId stays top-level), e.g. { sendRequest: fn } → { mcpReq: { send: fn } }. Passed as-is to a migrated handler that reads ctx.mcpReq.*, the v1 shape throws "Cannot read properties of undefined". */
  const context: McpRequestContextValue = {
    requestId: "request-session-identity",
    correlationId: "corr-session-identity",
    sessionId: "mcp-session-1",
    client: normalizeMcpClient({ name: "ChatGPT", version: "1" }),
    method: "tools/call",
    startedAt: Date.now(),
    requestBytes: 120,
    outcome: { failed: false, errorCode: null },
  };
  const response = await mcpRequestContext.run(context, () =>
    sdkClient.callTool({
      name: "cptr_open_live_workbench",
      arguments: {
        session_name: "MCP topology identity",
        workspace_id: "workspace-123",
        client_model: "GPT-5.6 Sol",
      },
    }),
  );
  assert.equal(response.isError, undefined);
  await emitter.flush();
  await Promise.all([sdkClient.close(), server.close()]);
  await emitter.close();

  const events = delivered
    .flat()
    .filter((event) => event.tool_name === "cptr_open_live_workbench");
  assert.deepEqual(
    events.map((event) => event.event_type),
    ["tool_started", "tool_finished"],
  );
  for (const event of events) {
    assert.equal(event.client.id, "chatgpt-session-mcp-session-1");
    assert.equal(event.client.session_name, "MCP topology identity");
    assert.equal(event.client.model, "GPT-5.6 Sol");
    assert.equal(event.client.workspace_id, "workspace-123");
    assert.equal(event.client.workspace_name, "Desktop");
  }
});

test("MCP traffic error codes are normalized without exposing exception text", () => {
  assert.equal(normalizeTrafficErrorCode({ status: 401 }), "unauthorized");
  assert.equal(normalizeTrafficErrorCode({ status: 400 }), "validation_error");
  assert.equal(
    normalizeTrafficErrorCode({
      name: "TimeoutError",
      message: "secret path /tmp/a",
    }),
    "timeout",
  );
  assert.equal(
    normalizeTrafficErrorCode(new Error("Bearer abc /home/user/private")),
    "internal_error",
  );
});

test("MCP traffic emitter is synchronous, bounded, batched, and allowlist-only", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delivered: McpTrafficEvent[][] = [];
  const emitter = new McpTrafficEmitter({
    env: {
      CPTR_MCP_TRAFFIC_PLUGIN_BATCH_SIZE: "3",
      CPTR_MCP_TRAFFIC_PLUGIN_FLUSH_MS: "10000",
      CPTR_MCP_TRAFFIC_PLUGIN_MAX_QUEUE: "10",
    },
    deliver: async (events) => {
      delivered.push(events);
      await blocked;
    },
  });
  const client = normalizeMcpClient({ name: "ChatGPT", version: "1" });

  const startedAt = Date.now();
  for (let index = 0; index < 20; index += 1) {
    /* @mcp-codemod-error This object looks like a v1 handler-context mock (requestId, sessionId). v2 nests the context — reshape it (requestId → mcpReq.id; sessionId stays top-level), e.g. { sendRequest: fn } → { mcpReq: { send: fn } }. Passed as-is to a migrated handler that reads ctx.mcpReq.*, the v1 shape throws "Cannot read properties of undefined". */
    emitter.requestStarted({
      requestId: `request-${index}`,
      correlationId: `corr-${index}`,
      sessionId: "session-1",
      client,
      method: "tools/call",
      requestBytes: 120,
    });
  }
  assert.ok(
    Date.now() - startedAt < 100,
    "emitting must not await telemetry delivery",
  );
  assert.deepEqual(emitter.stats(), {
    queued: 10,
    dropped: 10,
    delivering: false,
  });

  const flushPromise = emitter.flush();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].length, 3);
  assert.equal(emitter.stats().delivering, true);

  const encoded = JSON.stringify(delivered[0]).toLowerCase();
  for (const forbidden of [
    "authorization",
    "arguments",
    "result",
    "prompt",
    "/home/",
    "/tmp/",
  ]) {
    assert.equal(
      encoded.includes(forbidden),
      false,
      `must not include ${forbidden}`,
    );
  }

  release?.();
  await flushPromise;
  await emitter.close();
});

test("MCP traffic delivery rejection is swallowed and reports one best-effort failure callback", async () => {
  const failures: Array<{
    error: unknown;
    events: readonly McpTrafficEvent[];
  }> = [];
  const emitter = new McpTrafficEmitter({
    env: {
      CPTR_MCP_TRAFFIC_PLUGIN_BATCH_SIZE: "1",
      CPTR_MCP_TRAFFIC_PLUGIN_FLUSH_MS: "25",
      CPTR_MCP_TRAFFIC_PLUGIN_MAX_QUEUE: "10",
    },
    deliver: async () => {
      throw new Error("delivery unavailable with Bearer secret");
    },
    onDeliveryFailure: (error, events) => failures.push({ error, events }),
  });
  const client = normalizeMcpClient({ name: "ChatGPT" });
  assert.doesNotThrow(() => emitter.sessionOpened("session-1", client));
  await emitter.flush();
  assert.equal(emitter.stats().queued, 0);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].events.length, 1);
  await emitter.close();
});

test("MCP traffic request contexts remain isolated across concurrent work", async () => {
  const delivered: McpTrafficEvent[][] = [];
  const emitter = new McpTrafficEmitter({
    env: {
      CPTR_MCP_TRAFFIC_PLUGIN_BATCH_SIZE: "10",
      CPTR_MCP_TRAFFIC_PLUGIN_FLUSH_MS: "10000",
    },
    deliver: async (events) => {
      delivered.push(events);
    },
  });
  const client = normalizeMcpClient({ name: "ChatGPT" });
  const context = (requestId: string): McpRequestContextValue => ({
    requestId,
    correlationId: `corr-${requestId}`,
    sessionId: "session-1",
    client,
    method: "tools/call",
    startedAt: Date.now(),
    requestBytes: 20,
    outcome: { failed: false, errorCode: null },
  });

  await Promise.all([
    mcpRequestContext.run(context("request-a"), async () => {
      await Promise.resolve();
      emitter.toolStarted("tool-a");
      emitter.toolFinished("tool-a");
    }),
    mcpRequestContext.run(context("request-b"), async () => {
      await new Promise((resolve) => setImmediate(resolve));
      emitter.toolStarted("tool-b");
      emitter.toolFinished("tool-b");
    }),
  ]);
  await emitter.flush();
  await emitter.close();
  const events = delivered.flat();
  assert.deepEqual(
    events
      .filter((event) => event.event_type === "tool_started")
      .map((event) => [event.tool_name, event.request_id])
      .sort(),
    [
      ["tool-a", "request-a"],
      ["tool-b", "request-b"],
    ],
  );
});

test("MCP traffic instruments the existing registerTool boundary without changing tool behavior", async () => {
  const delivered: McpTrafficEvent[][] = [];
  const emitter = new McpTrafficEmitter({
    env: {
      CPTR_MCP_TRAFFIC_PLUGIN_BATCH_SIZE: "10",
      CPTR_MCP_TRAFFIC_PLUGIN_FLUSH_MS: "10000",
    },
    deliver: async (events) => {
      delivered.push(events);
    },
  });
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async (input) => {
      if (String(input).includes("/workspaces?")) {
        return new Response(JSON.stringify({ workspaces: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const server = createMcpServer(computer, { traffic: emitter });
  const sdkClient = new Client({ name: "ChatGPT", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    sdkClient.connect(clientTransport),
  ]);

  /* @mcp-codemod-error This object looks like a v1 handler-context mock (requestId, sessionId). v2 nests the context — reshape it (requestId → mcpReq.id; sessionId stays top-level), e.g. { sendRequest: fn } → { mcpReq: { send: fn } }. Passed as-is to a migrated handler that reads ctx.mcpReq.*, the v1 shape throws "Cannot read properties of undefined". */
  const context: McpRequestContextValue = {
    requestId: "request-real-tool",
    correlationId: "corr-real-tool",
    sessionId: "session-real",
    client: normalizeMcpClient({ name: "ChatGPT", version: "1" }),
    method: "tools/call",
    startedAt: Date.now(),
    requestBytes: 44,
    outcome: { failed: false, errorCode: null },
  };
  const response = await mcpRequestContext.run(context, () =>
    sdkClient.callTool({ name: "cptr_list_workspaces", arguments: {} }),
  );
  assert.equal(response.isError, undefined);
  await emitter.flush();
  await Promise.all([sdkClient.close(), server.close()]);
  await emitter.close();

  const toolEvents = delivered
    .flat()
    .filter((event) => event.tool_name === "cptr_list_workspaces");
  assert.deepEqual(
    toolEvents.map((event) => event.event_type),
    ["tool_started", "tool_finished"],
  );
  assert.deepEqual(
    new Set(toolEvents.map((event) => event.request_id)),
    new Set(["request-real-tool"]),
  );
  assert.deepEqual(
    new Set(toolEvents.map((event) => event.correlation_id)),
    new Set(["corr-real-tool"]),
  );
});

test("MCP traffic delivery failure cannot fail a real MCP tool call", async () => {
  const emitter = new McpTrafficEmitter({
    env: {
      CPTR_MCP_TRAFFIC_PLUGIN_BATCH_SIZE: "1",
      CPTR_MCP_TRAFFIC_PLUGIN_FLUSH_MS: "25",
    },
    deliver: async () => {
      throw new Error("telemetry destination unavailable");
    },
  });
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async () =>
      new Response(JSON.stringify({ workspaces: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  });
  const server = createMcpServer(computer, { traffic: emitter });
  const sdkClient = new Client({ name: "ChatGPT", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    sdkClient.connect(clientTransport),
  ]);
  /* @mcp-codemod-error This object looks like a v1 handler-context mock (requestId, sessionId). v2 nests the context — reshape it (requestId → mcpReq.id; sessionId stays top-level), e.g. { sendRequest: fn } → { mcpReq: { send: fn } }. Passed as-is to a migrated handler that reads ctx.mcpReq.*, the v1 shape throws "Cannot read properties of undefined". */
  const context: McpRequestContextValue = {
    requestId: "request-failure-isolation",
    correlationId: "corr-failure-isolation",
    sessionId: null,
    client: normalizeMcpClient({ name: "ChatGPT" }),
    method: "tools/call",
    startedAt: Date.now(),
    requestBytes: 12,
    outcome: { failed: false, errorCode: null },
  };
  const response = await mcpRequestContext.run(context, () =>
    sdkClient.callTool({ name: "cptr_list_workspaces", arguments: {} }),
  );
  assert.equal(response.isError, undefined);
  await emitter.flush();
  await Promise.all([sdkClient.close(), server.close()]);
  await emitter.close();
});

test("MCP traffic HTTP boundary instruments stateful sessions and stateless requests", async () => {
  const source = await readFile(
    new URL("../server/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /mcpTraffic\.sessionOpened\(sessionId, trafficClient\)/);
  assert.match(
    source,
    /mcpTraffic\.sessionClosed\(sessionId, record\.trafficClient\)/,
  );
  assert.match(source, /mcpTraffic\.requestStarted/);
  assert.match(source, /mcpTraffic\.requestFinished/);
  assert.match(source, /mcpTraffic\.requestFailed/);
  assert.match(source, /mcpRequestContext\.run/);
  assert.match(source, /handleStatelessCompatibilityRequest/);
  assert.match(source, /statelessServerPool\.take\(\)/);
  assert.match(source, /setup_kind: "stateless_setup"/);
  assert.match(source, /setup_cached: pooledServer\.pooled/);
  assert.match(source, /statelessServerPool\.scheduleReplenish\(\)/);
  assert.doesNotMatch(
    source,
    /handleStatelessCompatibilityRequest[\s\S]{0,1000}sessionOpened/,
  );
});

test("MCP traffic ComputerClient delivery uses the dedicated endpoint and sanitizes failures", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "super-secret-token",
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(
        JSON.stringify({ accepted: 1, duplicates: 0, dropped: 0 }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    },
  });
  const client = normalizeMcpClient({ name: "ChatGPT" });
  const emitter = new McpTrafficEmitter({
    deliver: (events) => computer.ingestMcpTraffic(events),
  });
  emitter.sessionOpened("session-1", client);
  await emitter.flush();
  await emitter.close();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://cptr.test/api/mcp/traffic/events");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(
    new Headers(calls[0].init?.headers).get("Authorization"),
    "Bearer super-secret-token",
  );
  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(body.events.length, 1);

  const failing = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "never-leak-me",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({ detail: "Bearer never-leak-me /private/path" }),
        { status: 500 },
      ),
  });
  await assert.rejects(
    failing.ingestMcpTraffic(body.events),
    (error: Error) =>
      !error.message.includes("never-leak-me") &&
      !error.message.includes("/private/path"),
  );
});
