import assert from "node:assert/strict";
import test from "node:test";
import { ComputerApiError, ComputerClient } from "../server/client/computer-client.js";

test("forwards the scoped token and returns JSON", async () => {
  let seenRequest: RequestInit | undefined;
  const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
    seenRequest = init;
    return new Response(JSON.stringify({ workspaces: [] }), { status: 200 });
  };
  const client = new ComputerClient({ baseUrl: "http://cptr.test/", token: "secret", fetchImpl });
  assert.deepEqual(await client.listWorkspaces(), { workspaces: [] });
  assert.equal((seenRequest?.headers as Record<string, string>).Authorization, "Bearer secret");
});

test("normalizes CPTR errors without exposing credentials", async () => {
  const client = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "secret-token",
    fetchImpl: async () => new Response(JSON.stringify({ detail: "missing required scope: task:read" }), { status: 403 }),
  });
  await assert.rejects(client.getTask("task-1"), (error: unknown) => {
    assert.ok(error instanceof ComputerApiError);
    assert.equal(error.status, 403);
    assert.equal(error.message, "missing required scope: task:read");
    assert.equal(error.message.includes("secret-token"), false);
    return true;
  });
});

test("converts request timeouts to a bounded public error", async () => {
  const client = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "secret-token",
    timeoutMs: 1,
    fetchImpl: (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }),
  });
  await assert.rejects(client.getTask("task-1"), (error: unknown) => {
    assert.ok(error instanceof ComputerApiError);
    assert.equal(error.status, 504);
    assert.equal(error.code, "computer_api_timeout");
    return true;
  });
});

test("routes dedicated autonomous operations to the scoped Control API", async () => {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const client = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "secret-token",
    fetchImpl: async (input, init) => {
      seen.push({ url: String(input), init });
      return new Response(JSON.stringify({ monitor_id: "mon-1", status: "RUNNING" }), { status: 200 });
    },
  });

  await client.createAutonomous({
    workspace_id: "ws-1",
    goal: "Repair the fixture",
    acceptance_criteria: ["tests pass"],
    model_id: "model-1",
  });
  await client.getAutonomous("mon-1");
  await client.getAutonomousEvents("mon-1");
  await client.getAutonomousEvidence("mon-1");
  await client.steerAutonomous("mon-1", "Continue", "steer-retry-1");
  await client.cancelAutonomous("mon-1");
  await client.approveAutonomous("mon-1", "approval-1", true);

  assert.deepEqual(seen.map((request) => request.url), [
    "http://cptr.test/api/control/v1/autonomous",
    "http://cptr.test/api/control/v1/autonomous/mon-1",
    "http://cptr.test/api/control/v1/autonomous/mon-1/events",
    "http://cptr.test/api/control/v1/autonomous/mon-1/evidence",
    "http://cptr.test/api/control/v1/autonomous/mon-1/messages",
    "http://cptr.test/api/control/v1/autonomous/mon-1/cancel",
    "http://cptr.test/api/control/v1/autonomous/mon-1/approve",
  ]);
  assert.equal((seen[3].init?.headers as Record<string, string>).Authorization, "Bearer secret-token");
  assert.deepEqual(JSON.parse(String(seen[4].init?.body)), {
    content: "Continue",
    idempotency_key: "steer-retry-1",
  });
});

test("forwards task steering idempotency keys", async () => {
  let body = "";
  const client = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "secret-token",
    fetchImpl: async (_input, init) => {
      body = String(init?.body ?? "");
      return new Response(JSON.stringify({ task_id: "task-1", status: "QUEUED" }), { status: 200 });
    },
  });

  await client.sendMessage("task-1", "STEERING_MARKER_1", "task-retry-1");

  assert.deepEqual(JSON.parse(body), {
    content: "STEERING_MARKER_1",
    idempotency_key: "task-retry-1",
  });
});

test("streams CPTR activity with server-side auth and a replay cursor", async () => {
  let seenUrl = "";
  let seenHeaders: Record<string, string> = {};
  const client = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "secret-token",
    fetchImpl: async (input, init) => {
      seenUrl = String(input);
      seenHeaders = init?.headers as Record<string, string>;
      return new Response("event: task.started\nid: 4\ndata: {}\n\n", { status: 200 });
    },
  });
  const response = await client.streamLive("task", "task-1", 3);
  assert.equal(response.ok, true);
  assert.equal(seenUrl, "http://cptr.test/api/control/v1/tasks/task-1/stream?after=3");
  assert.equal(seenHeaders.Authorization, "Bearer secret-token");
  assert.equal(seenHeaders.Accept, "text/event-stream");
  assert.equal(seenUrl.includes("secret-token"), false);
});
