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

test("browser surface activity reuses the prompt stream without credential fields", () => {
  const store = new PromptTerminalStore({ streamingEnabled: true });
  const metadata = store.open();
  assert.match(metadata.browserFrameUrl, /\/live\/prompt\/browser-frame$/);
  assert.match(metadata.browserInputUrl, /\/live\/prompt\/browser-input$/);
  const appended = store.append(metadata.ticket, {
    type: "browser.surface",
    payload: {
      action: "open_session",
      device_id: "bdv_1",
      session_id: "brs_1",
      state: "OBSERVING",
      owner: "none",
      epoch: 0,
      hostname: "Heidi Chrome",
    },
  });

  assert.equal(appended?.type, "browser.surface");
  const payload = appended?.payload as Record<string, unknown> | undefined;
  assert.equal(payload?.session_id, "brs_1");
  assert.equal(store.allowsBrowserSession(metadata.ticket, "brs_1"), true);
  assert.equal(store.allowsBrowserSession(metadata.ticket, "brs_other"), false);
  assert.equal(store.ticketForBrowserSession("brs_1"), metadata.ticket);
  assert.equal(JSON.stringify(payload).includes("credential"), false);

  store.revoke(metadata.ticket);
  assert.equal(store.ticketForBrowserSession("brs_1"), null, "revoking a prompt must clear its browser-session routing");
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

test("refreshes prompt-session expiry on successful snapshot/stream activity so long tasks do not lose the persistent widget", () => {
  let now = 1_000;
  const store = new PromptTerminalStore({ streamingEnabled: true, ttlMs: 60_000, now: () => now });
  const first = store.open();
  assert.equal(store.bindWorkbenchSession(first.ticket, "wbs-long-running"), true);

  now += 50_000;
  const replay = store.replay(first.ticket, 0);
  assert.ok(replay);
  assert.ok(replay.expires_at > first.expiresAt, "successful activity must extend the prompt-session lease");

  now += 50_000;
  assert.equal(store.ticketForWorkbenchSession("wbs-long-running"), first.ticket, "active prompt stream must remain bound across long execution windows");
});
