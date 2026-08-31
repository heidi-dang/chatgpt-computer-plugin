import assert from "node:assert/strict";
import test from "node:test";
import { ComputerClient } from "../server/client/computer-client.js";
import {
  McpTrafficEmitter,
  normalizeMcpClient,
  normalizeTrafficErrorCode,
  type McpTrafficEvent,
} from "../server/mcp-traffic.js";

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
