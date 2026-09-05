import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  ComputerApiError,
  ComputerClient,
} from "../server/client/computer-client.js";
import {
  McpActivityEmitter,
  type McpActivityEvent,
} from "../server/mcp-activity.js";
import {
  mcpRequestContext,
  normalizeMcpClient,
  type McpRequestContextValue,
} from "../server/mcp-traffic.js";
import { createMcpServer } from "../server/mcp.js";

const client = normalizeMcpClient({ name: "ChatGPT", version: "1" });

function startedInput(index = 1, argumentsJson = '{"ok":true}') {
  return {
    client,
    sessionId: "session-1",
    requestId: `request-${index}`,
    correlationId: `corr-${index}`,
    toolName: "cptr_list_workspaces",
    title: "List workspaces",
    summary: "Working: List workspaces.",
    argumentsJson,
  };
}

test("MCP activity emitter ignores non-active client identities", async () => {
  const delivered: McpActivityEvent[][] = [];
  const emitter = new McpActivityEmitter({
    batchSize: 10,
    flushMs: 10_000,
    deliver: async (events) => {
      delivered.push(events);
    },
  });

  emitter.started({
    ...startedInput(),
    client: normalizeMcpClient({ name: "Foreign MCP Client" }),
  });
  await emitter.flush();
  await emitter.close();

  assert.deepEqual(delivered, []);
});

test("MCP activity emitter is bounded, allowlist-only, and caps payload strings", async () => {
  const delivered: McpActivityEvent[][] = [];
  const emitter = new McpActivityEmitter({
    maxQueue: 2,
    batchSize: 2,
    flushMs: 10_000,
    deliver: async (events) => {
      delivered.push(events);
    },
  });

  emitter.started(startedInput(1));
  emitter.started(startedInput(2));
  emitter.started(startedInput(3, "x".repeat(14_000)));
  assert.deepEqual(emitter.stats(), {
    queued: 2,
    dropped: 1,
    delivering: false,
  });

  await emitter.flush();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].length, 2);
  assert.equal(delivered[0][1].arguments_json?.length, 13_000);
  assert.deepEqual(
    Object.keys(delivered[0][0]).sort(),
    [
      "arguments_json",
      "client",
      "correlation_id",
      "duration_ms",
      "error_json",
      "event_id",
      "phase",
      "request_id",
      "result_json",
      "sequence",
      "session_id",
      "summary",
      "timestamp_ms",
      "title",
      "tool_name",
      "version",
    ].sort(),
  );
  assert.equal(JSON.stringify(delivered[0]).includes("authorization"), false);
  await emitter.close();
});

test("MCP activity delivery rejection is isolated and reports one best-effort failure callback", async () => {
  const failures: Array<{
    error: unknown;
    events: readonly McpActivityEvent[];
  }> = [];
  const emitter = new McpActivityEmitter({
    maxQueue: 2,
    batchSize: 1,
    flushMs: 10_000,
    deliver: async () => {
      throw new Error("Bearer secret /private/path");
    },
    onDeliveryFailure: (error, events) => failures.push({ error, events }),
  });

  assert.doesNotThrow(() => emitter.started(startedInput()));
  assert.doesNotThrow(() =>
    emitter.complete({
      ...startedInput(),
      summary: "Completed: List workspaces.",
      resultJson: '{"workspaces":[]}',
      durationMs: 12,
    }),
  );
  await assert.doesNotReject(() => emitter.flush());
  assert.equal(emitter.stats().dropped, 2);
  assert.equal(failures.length, 2);
  assert.equal(
    failures.every((failure) => failure.events.length === 1),
    true,
  );
  await emitter.close();
});

test("activity ingestion posts to the dedicated CPTR endpoint with existing bearer auth", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "super-secret-token",
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ accepted: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const events: McpActivityEvent[] = [];
  const emitter = new McpActivityEmitter({
    flushMs: 10_000,
    deliver: async (batch) => {
      events.push(...batch);
    },
  });
  emitter.started(startedInput());
  await emitter.flush();
  await emitter.close();

  await computer.ingestMcpActivity(events);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://cptr.test/api/mcp/activity/events");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(
    new Headers(calls[0].init?.headers).get("Authorization"),
    "Bearer super-secret-token",
  );
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { events });
});

test("activity ingestion failures are generic and never include response bodies", async () => {
  for (const status of [401, 403, 500]) {
    const computer = new ComputerClient({
      baseUrl: "http://cptr.test",
      token: "never-leak-me",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ detail: "Bearer never-leak-me /private/path" }),
          { status },
        ),
    });
    await assert.rejects(computer.ingestMcpActivity([]), (error: unknown) => {
      assert.ok(error instanceof ComputerApiError);
      assert.equal(error.code, "mcp_activity_ingestion_failed");
      assert.equal(error.message.includes("never-leak-me"), false);
      assert.equal(error.message.includes("/private/path"), false);
      return true;
    });
  }
});

function requestContext(
  requestId: string,
  toolClient = client,
): McpRequestContextValue {
  return {
    requestId,
    correlationId: `corr-${requestId}`,
    sessionId: "session-1",
    client: toolClient,
    method: "tools/call",
    startedAt: Date.now(),
    requestBytes: 64,
    outcome: { failed: false, errorCode: null },
  };
}

function successfulComputer(): ComputerClient {
  return new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.includes("/coding/workers/")) {
        return new Response(
          JSON.stringify({
            worker_id: "dcw-1",
            workspace_id: "workspace-1",
            name: "Worker",
            responsibility: "Verify activity",
            repo_path: ".",
            status: "READY",
            branch: "feature/test",
            base_revision: "abc123",
            changed_file_count: 0,
            changed_paths: [],
            active_command_ids: [],
            recent_command_ids: [],
            created_at: 1,
            updated_at: 1,
            integrated_at: null,
            closed_at: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/workspaces?")) {
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
}

async function connectedServer(
  computer: ComputerClient,
  activityTelemetry: McpActivityEmitter,
): Promise<{ sdkClient: Client; server: ReturnType<typeof createMcpServer> }> {
  const server = createMcpServer(computer, { activityTelemetry });
  const sdkClient = new Client({ name: "ChatGPT", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    sdkClient.connect(clientTransport),
  ]);
  return { sdkClient, server };
}

test("MCP activity instruments a real registered action with correlated started and complete output", async () => {
  const delivered: McpActivityEvent[][] = [];
  const emitter = new McpActivityEmitter({
    flushMs: 10_000,
    deliver: async (events) => {
      delivered.push(events);
    },
  });
  const { sdkClient, server } = await connectedServer(
    successfulComputer(),
    emitter,
  );

  const response = await mcpRequestContext.run(
    requestContext("request-real"),
    () => sdkClient.callTool({ name: "cptr_list_workspaces", arguments: {} }),
  );
  assert.equal(response.isError, undefined);
  await emitter.flush();
  const events = delivered
    .flat()
    .filter((event) => event.tool_name === "cptr_list_workspaces");
  assert.deepEqual(
    events.map((event) => event.phase),
    ["started", "complete"],
  );
  assert.equal(events[0].arguments_json !== null, true);
  assert.equal(events[0].result_json, null);
  assert.equal(events[1].result_json !== null, true);
  assert.equal(events[1].error_json, null);
  assert.ok((events[1].duration_ms ?? -1) >= 0);
  assert.deepEqual(
    events.map((event) => [
      event.client.label,
      event.session_id,
      event.request_id,
    ]),
    [
      ["ChatGPT", "session-1", "request-real"],
      ["ChatGPT", "session-1", "request-real"],
    ],
  );
  assert.deepEqual(
    new Set(events.map((event) => event.correlation_id)),
    new Set(["corr-request-real"]),
  );

  await Promise.all([sdkClient.close(), server.close()]);
  await emitter.close();
});

test("MCP activity emits failed output from the same wrapper error envelope", async () => {
  const delivered: McpActivityEvent[][] = [];
  const emitter = new McpActivityEmitter({
    flushMs: 10_000,
    deliver: async (events) => {
      delivered.push(events);
    },
  });
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async () =>
      new Response(JSON.stringify({ detail: "backend failure" }), {
        status: 500,
      }),
  });
  const { sdkClient, server } = await connectedServer(computer, emitter);

  const response = await mcpRequestContext.run(
    requestContext("request-failed"),
    () => sdkClient.callTool({ name: "cptr_list_workspaces", arguments: {} }),
  );
  assert.equal(response.isError, true);
  await emitter.flush();
  const events = delivered
    .flat()
    .filter((event) => event.tool_name === "cptr_list_workspaces");
  assert.deepEqual(
    events.map((event) => event.phase),
    ["started", "failed"],
  );
  assert.equal(events[1].error_json !== null, true);
  assert.equal(events[1].result_json, null);
  assert.ok((events[1].duration_ms ?? -1) >= 0);

  await Promise.all([sdkClient.close(), server.close()]);
  await emitter.close();
});

test("worker-scoped direct coding actions also emit normalized MCP activity", async () => {
  const delivered: McpActivityEvent[][] = [];
  const emitter = new McpActivityEmitter({
    flushMs: 10_000,
    deliver: async (events) => {
      delivered.push(events);
    },
  });
  const { sdkClient, server } = await connectedServer(
    successfulComputer(),
    emitter,
  );

  const response = await mcpRequestContext.run(
    requestContext("request-worker"),
    () =>
      sdkClient.callTool({
        name: "cptr_direct_worker_get",
        arguments: { workspace_id: "workspace-1", worker_id: "dcw-1" },
      }),
  );
  assert.equal(response.isError, undefined);
  await emitter.flush();
  const events = delivered
    .flat()
    .filter((event) => event.tool_name === "cptr_direct_worker_get");
  assert.deepEqual(
    events.map((event) => event.phase),
    ["started", "complete"],
  );
  assert.equal(events[0].arguments_json?.includes("workspace-1"), true);
  assert.equal(events[1].result_json?.includes("dcw-1"), true);

  await Promise.all([sdkClient.close(), server.close()]);
  await emitter.close();
});

test("MCP activity delivery failure never changes a real tool result", async () => {
  const emitter = new McpActivityEmitter({
    batchSize: 1,
    flushMs: 1,
    deliver: async () => {
      throw new Error("activity destination unavailable");
    },
  });
  const { sdkClient, server } = await connectedServer(
    successfulComputer(),
    emitter,
  );

  const response = await mcpRequestContext.run(
    requestContext("request-isolation"),
    () => sdkClient.callTool({ name: "cptr_list_workspaces", arguments: {} }),
  );
  assert.equal(response.isError, undefined);
  await assert.doesNotReject(() => emitter.flush());
  assert.ok(emitter.stats().dropped >= 1);

  await Promise.all([sdkClient.close(), server.close()]);
  await emitter.close();
});

test("plugin process wires MCP activity delivery into stateful and stateless session servers", async () => {
  const source = await readFile(
    new URL("../server/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /new McpActivityEmitter\([\s\S]*client\.ingestMcpActivity\(events\)/,
  );
  assert.match(source, /onDeliveryFailure:[\s\S]*stage: "activity_delivery"/);
  assert.match(source, /activityTelemetry: mcpActivity/);
  assert.match(source, /diagnostics: mcpDiagnostics/);
  assert.match(source, /function createSessionServer\(\)/);
  assert.match(
    source,
    /handleStatefulInitialize[\s\S]*createSessionServer\(\)/,
  );
  assert.match(source, /new StatelessServerPool\([\s\S]*createSessionServer/);
  assert.match(
    source,
    /handleStatelessCompatibilityRequest[\s\S]*statelessServerPool\.take\(\)/,
  );
  assert.match(source, /mcpActivity\.close\(\)/);
});
