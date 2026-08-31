import assert from "node:assert/strict";
import test from "node:test";
import { ComputerApiError, ComputerClient } from "../server/client/computer-client.js";
import {
  McpActivityEmitter,
  type McpActivityEvent,
} from "../server/mcp-activity.js";
import { normalizeMcpClient } from "../server/mcp-traffic.js";

const client = normalizeMcpClient({ name: "ChatGPT", version: "1" });

function startedInput(index = 1, argumentsJson = '{"ok":true}') {
  return {
    client,
    sessionId: "session-1",
    requestId: `request-${index}`,
    toolName: "cptr_list_workspaces",
    title: "List workspaces",
    summary: "Working: List workspaces.",
    argumentsJson,
  };
}

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
  assert.deepEqual(emitter.stats(), { queued: 2, dropped: 1, delivering: false });

  await emitter.flush();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].length, 2);
  assert.equal(delivered[0][1].arguments_json?.length, 13_000);
  assert.deepEqual(
    Object.keys(delivered[0][0]).sort(),
    [
      "arguments_json",
      "client",
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

test("MCP activity delivery rejection is isolated from emit calls", async () => {
  const emitter = new McpActivityEmitter({
    maxQueue: 2,
    batchSize: 1,
    flushMs: 10_000,
    deliver: async () => {
      throw new Error("Bearer secret /private/path");
    },
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
  assert.equal(new Headers(calls[0].init?.headers).get("Authorization"), "Bearer super-secret-token");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { events });
});

test("activity ingestion failures are generic and never include response bodies", async () => {
  for (const status of [401, 403, 500]) {
    const computer = new ComputerClient({
      baseUrl: "http://cptr.test",
      token: "never-leak-me",
      fetchImpl: async () =>
        new Response(JSON.stringify({ detail: "Bearer never-leak-me /private/path" }), { status }),
    });
    await assert.rejects(
      computer.ingestMcpActivity([]),
      (error: unknown) => {
        assert.ok(error instanceof ComputerApiError);
        assert.equal(error.code, "mcp_activity_ingestion_failed");
        assert.equal(error.message.includes("never-leak-me"), false);
        assert.equal(error.message.includes("/private/path"), false);
        return true;
      },
    );
  }
});
