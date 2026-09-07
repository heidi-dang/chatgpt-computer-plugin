import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { PromptTerminalGateway, PromptTerminalStore } from "../server/prompt-terminal.js";

const SECRET = "test-prompt-ticket-secret-that-is-stable-across-restarts";

test("prompt capability restores after restart and resumes from the browser cursor", () => {
  let now = 1_000;
  const before = new PromptTerminalStore({ ticketSecret: SECRET, ttlMs: 60_000, renewGraceMs: 60_000, now: () => now });
  const issued = before.open({ allowDelegate: true, workbenchSessionId: "wbs-restart-safe" });
  before.append(issued.ticket, {
    type: "mcp.tool",
    payload: { tool_name: "cptr_code_read_file", summary: "Completed: old process event.", status: "COMPLETE" },
  });

  const after = new PromptTerminalStore({ ticketSecret: SECRET, ttlMs: 60_000, renewGraceMs: 60_000, now: () => now });
  const replay = after.replay(issued.ticket, 17);

  assert.ok(replay, "the sealed prompt capability must remain authentic after restart");
  assert.equal(replay?.last_sequence, 17, "the browser cursor becomes the recovered sequence floor when process-local replay is gone");
  assert.deepEqual(replay?.events, []);
  assert.equal(after.ticketForWorkbenchSession("wbs-restart-safe"), issued.ticket);
  assert.equal(after.allowsDelegation(issued.ticket), false, "restart recovery must fail closed for per-turn delegation authority");
});

test("old prompt card converges on a newly issued generation after restart", () => {
  const before = new PromptTerminalStore({ ticketSecret: SECRET, ttlMs: 60_000, renewGraceMs: 60_000 });
  const oldCard = before.open({ workbenchSessionId: "wbs-generation" });

  const restarted = new PromptTerminalStore({ ticketSecret: SECRET, ttlMs: 60_000, renewGraceMs: 60_000 });
  const currentCard = restarted.open({ workbenchSessionId: "wbs-generation" });
  const recovered = restarted.renew(oldCard.ticket);

  assert.ok(currentCard.ticket);
  assert.notEqual(currentCard.ticket, oldCard.ticket);
  assert.equal(recovered?.ticket, currentCard.ticket, "a stale mounted card must receive the one current Workbench ticket instead of rotating forever");
});

test("duplicate prompt renewals are idempotent within one process", () => {
  const store = new PromptTerminalStore({ ticketSecret: SECRET, ttlMs: 60_000, renewGraceMs: 60_000 });
  const issued = store.open({ workbenchSessionId: "wbs-idempotent" });

  const first = store.renew(issued.ticket);
  const duplicate = store.renew(issued.ticket);

  assert.ok(first?.ticket);
  assert.equal(duplicate?.ticket, first?.ticket);
});

test("explicit prompt revocation cannot restore delegation or stream authority", () => {
  const store = new PromptTerminalStore({ ticketSecret: SECRET, ttlMs: 60_000, renewGraceMs: 60_000 });
  const issued = store.open({ allowDelegate: true, workbenchSessionId: "wbs-revoked" });
  store.revoke(issued.ticket);

  assert.equal(store.replay(issued.ticket, 0), null);
  assert.equal(store.renew(issued.ticket), null);
  assert.equal(store.allowsDelegation(issued.ticket), false);

  const replacement = store.open({ workbenchSessionId: "wbs-revoked" });
  assert.notEqual(replacement.ticket, issued.ticket);
  assert.ok(store.renew(replacement.ticket), "a server-authorized replacement capability must remain renewable");
  assert.equal(store.renew(issued.ticket), null, "the revoked capability must remain revoked after replacement");
});

test("legacy prompt renew retires pre-fix cards without browser authority or another retry", () => {
  const store = new PromptTerminalStore({
    ticketSecret: SECRET,
    streamUrl: "https://plugin.test/live/prompt/stream",
    snapshotUrl: "https://plugin.test/live/prompt/snapshot",
    renewUrl: "https://plugin.test/live/prompt/renew",
    browserFrameUrl: "https://plugin.test/live/prompt/browser-frame",
    browserInputUrl: "https://plugin.test/live/prompt/browser-input",
  });
  const gateway = new PromptTerminalGateway(store);
  const request = Object.assign(new EventEmitter(), {
    method: "POST",
    url: "/live/prompt/renew",
    headers: { authorization: "Bearer oldRandomOpaqueTicket" },
  });
  const response = {
    status: 0,
    body: "",
    headers: {} as Record<string, string>,
    writeHead(status: number, headers: Record<string, string>) { this.status = status; this.headers = headers; },
    end(body?: string) { this.body = body ?? ""; },
  };

  gateway.handleRenew(request as never, response as never);

  assert.equal(response.status, 200);
  assert.equal(response.headers["x-cptr-stream-state"], "legacy-retired");
  const retired = JSON.parse(response.body) as Record<string, unknown>;
  assert.equal(retired.streamingEnabled, false);
  assert.equal("browserFrameUrl" in retired, false);
  assert.equal("browserInputUrl" in retired, false);
});
