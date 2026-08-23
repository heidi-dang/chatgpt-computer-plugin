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

test("routes persistent monitor actions to the scoped Control API", async () => {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const client = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "secret-token",
    fetchImpl: async (input, init) => {
      seen.push({ url: String(input), init });
      return new Response(JSON.stringify({ monitor_id: "mon-1", status: "RUNNING" }), { status: 200 });
    },
  });

  await client.monitorAutonomous({ action: "status", monitor_id: "mon-1" });
  await client.monitorAutonomous({ action: "evidence", monitor_id: "mon-1" });
  await client.monitorAutonomous({ action: "steer", monitor_id: "mon-1", content: "Continue" });
  await client.monitorAutonomous({ action: "approve", monitor_id: "mon-1", approval_id: "approval-1", approved: true });

  assert.deepEqual(seen.map((request) => request.url), [
    "http://cptr.test/api/control/v1/autonomous/mon-1",
    "http://cptr.test/api/control/v1/autonomous/mon-1/evidence",
    "http://cptr.test/api/control/v1/autonomous/mon-1/messages",
    "http://cptr.test/api/control/v1/autonomous/mon-1/approve",
  ]);
  assert.equal((seen[3].init?.headers as Record<string, string>).Authorization, "Bearer secret-token");
});
