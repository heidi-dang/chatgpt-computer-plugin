import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ComputerClient } from "../server/client/computer-client.js";
import {
  McpTrafficEmitter,
  mcpRequestContext,
  normalizeMcpClient,
  normalizeTrafficErrorCode,
  type McpRequestContextValue,
  type McpTrafficEvent,
} from "../server/mcp-traffic.js";
import { createMcpServer } from "../server/mcp.js";

test("MCP traffic normalizes known clients and preserves safe unknown labels", () => {
  assert.deepEqual(normalizeMcpClient({ name: "ChatGPT", version: "1" }), {
    id: "chatgpt",
    label: "ChatGPT",
    version: "1",
  });
  assert.equal(normalizeMcpClient({ name: "Claude Desktop" }).label, "Claude");
  assert.equal(normalizeMcpClient({ name: "gemini-cli" }).label, "Gemini");
  assert.equal(normalizeMcpClient({ name: "Codex CLI" }).label, "Codex");
  assert.equal(normalizeMcpClient({ name: "My Internal MCP Client" }).label, "My Internal MCP Client");
  assert.equal(normalizeMcpClient({ name: "x".repeat(200) }).label.length, 80);
});

test("MCP traffic error codes are normalized without exposing exception text", () => {
  assert.equal(normalizeTrafficErrorCode({ status: 401 }), "unauthorized");
  assert.equal(normalizeTrafficErrorCode({ status: 400 }), "validation_error");
  assert.equal(normalizeTrafficErrorCode({ name: "TimeoutError", message: "secret path /tmp/a" }), "timeout");
  assert.equal(normalizeTrafficErrorCode(new Error("Bearer abc /home/user/private")), "internal_error");
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
    emitter.requestStarted({
      requestId: `request-${index}`,
      sessionId: "session-1",
      client,
      method: "tools/call",
      requestBytes: 120,
    });
  }
  assert.ok(Date.now() - startedAt < 100, "emitting must not await telemetry delivery");
  assert.deepEqual(emitter.stats(), { queued: 10, dropped: 10, delivering: false });

  const flushPromise = emitter.flush();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].length, 3);
  assert.equal(emitter.stats().delivering, true);

  const encoded = JSON.stringify(delivered[0]).toLowerCase();
  for (const forbidden of ["authorization", "arguments", "result", "prompt", "/home/", "/tmp/"]) {
    assert.equal(encoded.includes(forbidden), false, `must not include ${forbidden}`);
  }

  release?.();
  await flushPromise;
  await emitter.close();
});

test("MCP traffic delivery rejection is swallowed and does not reject emit calls", async () => {
  const emitter = new McpTrafficEmitter({
    env: {
      CPTR_MCP_TRAFFIC_PLUGIN_BATCH_SIZE: "1",
      CPTR_MCP_TRAFFIC_PLUGIN_FLUSH_MS: "25",
      CPTR_MCP_TRAFFIC_PLUGIN_MAX_QUEUE: "10",
    },
    deliver: async () => {
      throw new Error("delivery unavailable with Bearer secret");
    },
  });
  const client = normalizeMcpClient({ name: "Gemini" });
  assert.doesNotThrow(() => emitter.sessionOpened("session-1", client));
  await emitter.flush();
  assert.equal(emitter.stats().queued, 0);
  await emitter.close();
});

test("MCP traffic request contexts remain isolated across concurrent work", async () => {
  const delivered: McpTrafficEvent[][] = [];
  const emitter = new McpTrafficEmitter({
    env: { CPTR_MCP_TRAFFIC_PLUGIN_BATCH_SIZE: "10", CPTR_MCP_TRAFFIC_PLUGIN_FLUSH_MS: "10000" },
    deliver: async (events) => {
      delivered.push(events);
    },
  });
  const client = normalizeMcpClient({ name: "ChatGPT" });
  const context = (requestId: string): McpRequestContextValue => ({
    requestId,
    sessionId: "session-1",
    client,
    method: "tools/call",
    startedAt: Date.now(),
    requestBytes: 20,
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
    events.filter((event) => event.event_type === "tool_started").map((event) => [event.tool_name, event.request_id]).sort(),
    [["tool-a", "request-a"], ["tool-b", "request-b"]],
  );
});

test("MCP traffic instruments the existing registerTool boundary without changing tool behavior", async () => {
  const delivered: McpTrafficEvent[][] = [];
  const emitter = new McpTrafficEmitter({
    env: { CPTR_MCP_TRAFFIC_PLUGIN_BATCH_SIZE: "10", CPTR_MCP_TRAFFIC_PLUGIN_FLUSH_MS: "10000" },
    deliver: async (events) => {
      delivered.push(events);
    },
  });
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async (input) => {
      if (String(input).includes("/workspaces?")) {
        return new Response(JSON.stringify({ workspaces: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  const server = createMcpServer(computer, { traffic: emitter });
  const sdkClient = new Client({ name: "ChatGPT", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), sdkClient.connect(clientTransport)]);

  const context: McpRequestContextValue = {
    requestId: "request-real-tool",
    sessionId: "session-real",
    client: normalizeMcpClient({ name: "ChatGPT", version: "1" }),
    method: "tools/call",
    startedAt: Date.now(),
    requestBytes: 44,
  };
  const response = await mcpRequestContext.run(context, () =>
    sdkClient.callTool({ name: "cptr_list_workspaces", arguments: {} }),
  );
  assert.equal(response.isError, undefined);
  await emitter.flush();
  await Promise.all([sdkClient.close(), server.close()]);
  await emitter.close();

  const toolEvents = delivered.flat().filter((event) => event.tool_name === "cptr_list_workspaces");
  assert.deepEqual(toolEvents.map((event) => event.event_type), ["tool_started", "tool_finished"]);
  assert.deepEqual(new Set(toolEvents.map((event) => event.request_id)), new Set(["request-real-tool"]));
});

test("MCP traffic delivery failure cannot fail a real MCP tool call", async () => {
  const emitter = new McpTrafficEmitter({
    env: { CPTR_MCP_TRAFFIC_PLUGIN_BATCH_SIZE: "1", CPTR_MCP_TRAFFIC_PLUGIN_FLUSH_MS: "25" },
    deliver: async () => {
      throw new Error("telemetry destination unavailable");
    },
  });
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async () => new Response(JSON.stringify({ workspaces: [] }), { status: 200, headers: { "Content-Type": "application/json" } }),
  });
  const server = createMcpServer(computer, { traffic: emitter });
  const sdkClient = new Client({ name: "Gemini", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), sdkClient.connect(clientTransport)]);
  const context: McpRequestContextValue = {
    requestId: "request-failure-isolation",
    sessionId: null,
    client: normalizeMcpClient({ name: "Gemini" }),
    method: "tools/call",
    startedAt: Date.now(),
    requestBytes: 12,
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
  const source = await readFile(new URL("../server/index.ts", import.meta.url), "utf8");
  assert.match(source, /mcpTraffic\.sessionOpened\(sessionId, trafficClient\)/);
  assert.match(source, /mcpTraffic\.sessionClosed\(sessionId, record\.trafficClient\)/);
  assert.match(source, /mcpTraffic\.requestStarted/);
  assert.match(source, /mcpTraffic\.requestFinished/);
  assert.match(source, /mcpTraffic\.requestFailed/);
  assert.match(source, /mcpRequestContext\.run/);
  assert.match(source, /handleStatelessCompatibilityRequest/);
  assert.doesNotMatch(source, /handleStatelessCompatibilityRequest[\s\S]{0,1000}sessionOpened/);
});

test("MCP traffic ComputerClient delivery uses the dedicated endpoint and sanitizes failures", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "super-secret-token",
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ accepted: 1, duplicates: 0, dropped: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const client = normalizeMcpClient({ name: "ChatGPT" });
  const emitter = new McpTrafficEmitter({ deliver: (events) => computer.ingestMcpTraffic(events) });
  emitter.sessionOpened("session-1", client);
  await emitter.flush();
  await emitter.close();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://cptr.test/api/mcp/traffic/events");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(new Headers(calls[0].init?.headers).get("Authorization"), "Bearer super-secret-token");
  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(body.events.length, 1);

  const failing = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "never-leak-me",
    fetchImpl: async () => new Response(JSON.stringify({ detail: "Bearer never-leak-me /private/path" }), { status: 500 }),
  });
  await assert.rejects(
    failing.ingestMcpTraffic(body.events),
    (error: Error) => !error.message.includes("never-leak-me") && !error.message.includes("/private/path"),
  );
});
