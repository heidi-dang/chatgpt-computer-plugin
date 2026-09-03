import assert from "node:assert/strict";
import test from "node:test";
import { PromptTerminalStore, resolveLiveTerminalStreaming } from "../server/prompt-terminal.js";

test("live terminal streaming is enabled by default with an explicit emergency kill switch", () => {
  assert.equal(resolveLiveTerminalStreaming({}), true);
  assert.equal(resolveLiveTerminalStreaming({ CPTR_LIVE_TERMINAL_STREAMING: "0" }), false);
  assert.equal(resolveLiveTerminalStreaming({ CPTR_LIVE_TERMINAL_STREAMING: "false" }), false);
  assert.equal(resolveLiveTerminalStreaming({ CPTR_LIVE_TERMINAL_STREAMING: "off" }), false);
  assert.equal(resolveLiveTerminalStreaming({ CPTR_LIVE_TERMINAL_STREAMING: "no" }), false);
  assert.equal(resolveLiveTerminalStreaming({ CPTR_LIVE_TERMINAL_STREAMING: "1" }), true);
  assert.equal(resolveLiveTerminalStreaming({ CPTR_LIVE_TERMINAL_STREAMING: "TRUE" }), true);
  assert.equal(resolveLiveTerminalStreaming({ CPTR_LIVE_TERMINAL_STREAMING: " on " }), true);
});

test("disabled streaming keeps prompt authorization but records no live UI events", () => {
  const store = new PromptTerminalStore({ streamingEnabled: false });
  const metadata = store.open({ allowDelegate: true });

  assert.equal(metadata.streamingEnabled, false);
  assert.equal(store.streamingEnabled, false);
  assert.equal(store.allowsDelegation(metadata.ticket), true);
  assert.equal(store.append(metadata.ticket, {
    type: "mcp.tool",
    payload: {
      tool_name: "cptr_code_read_file",
      summary: "Completed: read source file.",
      status: "COMPLETE",
    },
  }), null);
  assert.equal(store.subscribe(metadata.ticket, () => undefined), null);
  assert.deepEqual(store.replay(metadata.ticket, 0)?.events, []);
});

test("live terminal streaming implementation remains available when enabled", () => {
  const store = new PromptTerminalStore({ streamingEnabled: true });
  const metadata = store.open();

  assert.equal(metadata.streamingEnabled, true);
  const appended = store.append(metadata.ticket, {
    type: "mcp.tool",
    payload: {
      tool_name: "cptr_code_read_file",
      summary: "Completed: read source file.",
      status: "COMPLETE",
    },
  });
  assert.equal(appended?.type, "mcp.tool");
  assert.equal(store.replay(metadata.ticket, 0)?.events.length, 1);
});


test("reuses and renews a workbench prompt stream while resetting per-turn delegation", () => {
  let now = 1_000;
  const store = new PromptTerminalStore({ streamingEnabled: true, ttlMs: 60_000, now: () => now });
  const first = store.open({ allowDelegate: true });
  assert.equal(store.bindWorkbenchSession(first.ticket, "wbs-persistent"), true);
  assert.equal(store.allowsDelegation(first.ticket), true);

  now += 30_000;
  const resumed = store.resumeWorkbenchSession("wbs-persistent", { allowDelegate: false });
  assert.ok(resumed);
  assert.equal(resumed.ticket, first.ticket, "the already-open widget must keep its prompt SSE ticket");
  assert.ok(resumed.expiresAt > first.expiresAt, "resuming a live task must renew the prompt stream lease");
  assert.equal(store.allowsDelegation(first.ticket), false, "delegation authorization must not leak into the next user turn");
});
