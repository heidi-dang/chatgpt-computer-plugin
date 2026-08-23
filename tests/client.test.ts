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
