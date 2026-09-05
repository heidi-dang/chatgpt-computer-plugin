import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ComputerApiError,
  ComputerClient,
} from "../server/client/computer-client.js";
import { normalizeMcpClient } from "../server/mcp-traffic.js";

const diagnosticsModule = await import("../server/mcp-diagnostics.js").catch(
  () => ({}) as Record<string, unknown>,
);

test("MCP diagnostics emitter ignores client-scoped events for non-active clients", async () => {
  const delivered: Array<Array<Record<string, unknown>>> = [];
  const Emitter = diagnosticsModule.McpDiagnosticsEmitter as new (
    options: Record<string, unknown>,
  ) => {
    failure: (input: Record<string, unknown>) => void;
    flush: () => Promise<void>;
    close: () => Promise<void>;
  };
  const emitter = new Emitter({
    batchSize: 10,
    flushMs: 10_000,
    deliver: async (events: Array<Record<string, unknown>>) => {
      delivered.push(events);
    },
  });

  emitter.failure({
    request_id: "request-foreign-client",
    correlation_id: null,
    session_id: null,
    client_id: "foreign-client",
    method: "tools/call",
    tool_name: "cptr_list_workspaces",
    stage: "cptr_backend",
    error_code: "backend_failure",
    http_status: 503,
    retryable: true,
    started_at_ms: 100,
    duration_ms: 25,
    request_bytes: 10,
    response_bytes: 20,
    summary: "Backend failed",
  });
  await emitter.flush();
  await emitter.close();

  assert.deepEqual(delivered, []);
});

test("MCP diagnostics emitter is bounded, allowlist-only, and sanitizes summaries", async () => {
  assert.equal(typeof diagnosticsModule.McpDiagnosticsEmitter, "function");
  const delivered: Array<Array<Record<string, unknown>>> = [];
  const Emitter = diagnosticsModule.McpDiagnosticsEmitter as new (
    options: Record<string, unknown>,
  ) => {
    latency: (input: Record<string, unknown>) => void;
    failure: (input: Record<string, unknown>) => void;
    stats: () => { queued: number; dropped: number; delivering: boolean };
    flush: () => Promise<void>;
    close: () => Promise<void>;
  };
  const emitter = new Emitter({
    batchSize: 2,
    flushMs: 10_000,
    maxQueue: 2,
    deliver: async (events: Array<Record<string, unknown>>) =>
      delivered.push(events),
  });

  emitter.latency({
    request_id: "request-1",
    correlation_id: "corr-1",
    edge_id: "client-mcp-connector",
    metric_type: "observed_request_time",
    duration_ms: 12,
    status: "ok",
  });
  emitter.failure({
    request_id: "request-1",
    correlation_id: "corr-1",
    session_id: "session-1",
    client_id: "chatgpt",
    method: "tools/call",
    tool_name: "cptr_list_workspaces",
    stage: "cptr_backend",
    error_code: "backend_failure",
    http_status: 503,
    retryable: true,
    started_at_ms: 100,
    duration_ms: 25,
    request_bytes: 10,
    response_bytes: 20,
    summary: "Backend failed at /home/private and Bearer top-secret\nnext line",
  });
  emitter.failure({
    request_id: null,
    correlation_id: null,
    session_id: null,
    client_id: "chatgpt",
    method: null,
    tool_name: null,
    stage: "client_transport",
    error_code: "malformed_request",
    http_status: 400,
    retryable: false,
    started_at_ms: null,
    duration_ms: null,
    request_bytes: null,
    response_bytes: null,
    summary: "Malformed request.",
  });
  assert.deepEqual(emitter.stats(), {
    queued: 2,
    dropped: 1,
    delivering: false,
  });

  await emitter.flush();
  await emitter.close();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].length, 2);
  const encoded = JSON.stringify(delivered).toLowerCase();
  for (const forbidden of [
    "authorization",
    "headers",
    "arguments",
    "result",
    "top-secret",
    "/home/",
  ]) {
    assert.equal(
      encoded.includes(forbidden),
      false,
      `diagnostics must not contain ${forbidden}`,
    );
  }
  const failure = delivered[0].find((event) => event.kind === "failure");
  assert.ok(failure);
  assert.equal(
    failure.summary,
    "Backend failed at <redacted-path> and Bearer [REDACTED] next line",
  );
});

test("latency diagnostics preserve bounded operation classification without leaking arguments", async () => {
  const delivered: Array<Array<Record<string, unknown>>> = [];
  const Emitter = diagnosticsModule.McpDiagnosticsEmitter as new (
    options: Record<string, unknown>,
  ) => {
    latency: (input: Record<string, unknown>) => void;
    flush: () => Promise<void>;
    close: () => Promise<void>;
  };
  const emitter = new Emitter({
    batchSize: 10,
    flushMs: 10_000,
    maxQueue: 10,
    deliver: async (events: Array<Record<string, unknown>>) =>
      delivered.push(events),
  });
  emitter.latency({
    request_id: "request-1",
    correlation_id: "corr-1",
    edge_id: "client-mcp-connector",
    metric_type: "observed_request_time",
    duration_ms: 5_200,
    status: "ok",
    tool_name: "cptr_execute_task",
    operation_class: "bounded_wait",
    requested_wait_ms: 5_000,
    health_eligible: false,
    setup_kind: "stateless_setup",
    setup_cached: true,
  });
  await emitter.flush();
  await emitter.close();

  assert.equal(delivered[0]?.[0]?.tool_name, "cptr_execute_task");
  assert.equal(delivered[0]?.[0]?.operation_class, "bounded_wait");
  assert.equal(delivered[0]?.[0]?.requested_wait_ms, 5_000);
  assert.equal(delivered[0]?.[0]?.health_eligible, false);
  assert.equal(delivered[0]?.[0]?.setup_kind, "stateless_setup");
  assert.equal(delivered[0]?.[0]?.setup_cached, true);
  assert.equal(JSON.stringify(delivered).includes("prompt"), false);
});

test("diagnostics delivery rejection is swallowed and counted without recursion", async () => {
  assert.equal(typeof diagnosticsModule.McpDiagnosticsEmitter, "function");
  const Emitter = diagnosticsModule.McpDiagnosticsEmitter as new (
    options: Record<string, unknown>,
  ) => {
    latency: (input: Record<string, unknown>) => void;
    stats: () => { queued: number; dropped: number; delivering: boolean };
    flush: () => Promise<void>;
    close: () => Promise<void>;
  };
  const emitter = new Emitter({
    batchSize: 1,
    flushMs: 10_000,
    maxQueue: 2,
    deliver: async () => {
      throw new Error("diagnostics destination unavailable with Bearer secret");
    },
  });
  emitter.latency({
    request_id: null,
    correlation_id: null,
    edge_id: "mcp-connector-cptr-mcp",
    metric_type: "adapter_handoff",
    duration_ms: 1,
    status: "ok",
  });
  await assert.doesNotReject(() => emitter.flush());
  assert.equal(emitter.stats().dropped, 1);
  await emitter.close();
});

test("ComputerClient diagnostics delivery uses the dedicated endpoint with generic failures", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "secret-token",
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(
        JSON.stringify({ accepted: 1, duplicates: 0, dropped: 0 }),
        { status: 200 },
      );
    },
  });
  assert.equal(
    typeof (computer as unknown as { ingestMcpDiagnostics?: unknown })
      .ingestMcpDiagnostics,
    "function",
  );
  await (
    computer as unknown as {
      ingestMcpDiagnostics: (
        events: Array<Record<string, unknown>>,
      ) => Promise<void>;
    }
  ).ingestMcpDiagnostics([
    {
      kind: "latency",
      version: 1,
      event_id: "latency-001",
      timestamp_ms: 100,
      request_id: "request-1",
      correlation_id: "corr-1",
      edge_id: "cptr-mcp-cptr-backend",
      metric_type: "backend_api_rtt",
      duration_ms: 7,
      status: "ok",
    },
  ]);
  assert.equal(calls[0].url, "http://cptr.test/api/mcp/diagnostics/events");
  assert.equal(
    new Headers(calls[0].init?.headers).get("Authorization"),
    "Bearer secret-token",
  );

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
    (
      failing as unknown as {
        ingestMcpDiagnostics: (
          events: Array<Record<string, unknown>>,
        ) => Promise<void>;
      }
    ).ingestMcpDiagnostics([]),
    (error: unknown) => {
      assert.ok(error instanceof ComputerApiError);
      assert.equal(error.message.includes("never-leak-me"), false);
      assert.equal(error.message.includes("/private/path"), false);
      return true;
    },
  );
});

test("ComputerClient synchronously observes real backend request duration and outcome", async () => {
  const observations: Array<Record<string, unknown>> = [];
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async () =>
      new Response(JSON.stringify({ workspaces: [] }), { status: 200 }),
  });
  assert.equal(
    typeof (computer as unknown as { setRequestObserver?: unknown })
      .setRequestObserver,
    "function",
  );
  (
    computer as unknown as {
      setRequestObserver: (
        observer: (value: Record<string, unknown>) => void,
      ) => void;
    }
  ).setRequestObserver((observation) => observations.push(observation));
  await computer.listWorkspaces();
  assert.equal(observations.length, 1);
  assert.equal(observations[0].method, "GET");
  assert.match(String(observations[0].path), /^\/workspaces\?/);
  assert.equal(observations[0].status, 200);
  assert.equal(observations[0].error, null);
  assert.ok(Number(observations[0].durationMs) >= 0);
});

test("ComputerClient observer receives sanitized backend failures but cannot alter request results", async () => {
  const observations: Array<Record<string, unknown>> = [];
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async () =>
      new Response(JSON.stringify({ detail: "backend unavailable" }), {
        status: 503,
      }),
  });
  (
    computer as unknown as {
      setRequestObserver: (
        observer: (value: Record<string, unknown>) => void,
      ) => void;
    }
  ).setRequestObserver((observation) => {
    observations.push(observation);
    throw new Error("observer must be isolated");
  });
  await assert.rejects(computer.listWorkspaces(), (error: unknown) => {
    assert.ok(error instanceof ComputerApiError);
    assert.equal(error.status, 503);
    return true;
  });
  assert.equal(observations.length, 1);
  assert.equal(observations[0].status, 503);
  assert.ok(observations[0].error instanceof ComputerApiError);
});

test("ChatGPT HTTP adapter fallback identity and diagnostics wiring are explicit", async () => {
  assert.equal(normalizeMcpClient(undefined).label, "Unknown MCP Client");
  const source = await readFile(
    new URL("../server/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /return normalizeMcpClient\(\{ name: "ChatGPT" \}\);/);
  assert.match(source, /new McpDiagnosticsEmitter/);
  assert.match(source, /client\.ingestMcpDiagnostics/);
  assert.match(source, /client\.setRequestObserver/);
  assert.match(source, /mcpDiagnostics\.close\(\)/);
});
