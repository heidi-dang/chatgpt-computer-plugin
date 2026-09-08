import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { PromptTerminalGateway, PromptTerminalStore, resolveLiveTerminalStreaming } from "../server/prompt-terminal.js";

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

test("prompt SSE establishes the stream immediately before the first tool event", async () => {
  const store = new PromptTerminalStore({ streamingEnabled: true });
  const metadata = store.open();
  const gateway = new PromptTerminalGateway(store, { heartbeatMs: 60_000 });
  const request = Object.assign(new EventEmitter(), {
    url: "/live/prompt/stream",
    headers: { authorization: `Bearer ${metadata.ticket}` },
    destroyed: false,
  });
  const chunks: string[] = [];
  const response = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    statusCode: 0,
    flushCount: 0,
    writeHead(status: number) { this.statusCode = status; },
    flushHeaders() { this.flushCount += 1; },
    write(chunk: string) { chunks.push(String(chunk)); return true; },
    end() { this.writableEnded = true; },
  });

  const running = gateway.handleStream(request as never, response as never);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(response.statusCode, 200);
  assert.equal(response.flushCount, 1);
  assert.equal(chunks[0], ": connected\n\n");

  store.append(metadata.ticket, {
    type: "mcp.tool",
    payload: {
      tool_name: "cptr_code_read_file",
      summary: "Working: read source file.",
      status: "STARTED",
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(chunks.join(""), /event: mcp\.tool/);

  request.emit("close");
  await running;
});

test("prompt SSE reconnect resumes strictly after Last-Event-ID without duplicating terminal activity", async () => {
  const store = new PromptTerminalStore({ streamingEnabled: true });
  const metadata = store.open();
  const first = store.append(metadata.ticket, {
    type: "mcp.tool",
    payload: { tool_name: "cptr_code_run_command", summary: "Working: worker command.", status: "STARTED" },
  });
  const second = store.append(metadata.ticket, {
    type: "mcp.tool",
    payload: { tool_name: "cptr_code_run_command", summary: "Completed: worker command.", status: "COMPLETE" },
  });
  assert.equal(first?.sequence, 1);
  assert.equal(second?.sequence, 2);

  const gateway = new PromptTerminalGateway(store, { heartbeatMs: 60_000 });
  const request = Object.assign(new EventEmitter(), {
    url: "/live/prompt/stream",
    headers: {
      authorization: `Bearer ${metadata.ticket}`,
      "last-event-id": "1",
    },
    destroyed: false,
  });
  const chunks: string[] = [];
  const response = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    writeHead() {},
    flushHeaders() {},
    write(chunk: string) { chunks.push(String(chunk)); return true; },
    end() { this.writableEnded = true; },
  });

  const running = gateway.handleStream(request as never, response as never);
  await new Promise((resolve) => setImmediate(resolve));
  request.emit("close");
  await running;

  const body = chunks.join("");
  assert.doesNotMatch(body, /id: 1\n/, "the reconnect cursor must not replay the event already rendered before suspension");
  assert.match(body, /id: 2\n/);
  assert.equal((body.match(/id: 2\n/g) ?? []).length, 1, "the first unseen event must be delivered exactly once");
});

test("newer Workbench replaces a stale prompt stream even when the final capacity slot is occupied", async () => {
  const store = new PromptTerminalStore({ streamingEnabled: true });
  const metadata = store.open({ workbenchSessionId: "wbs-capacity" });
  const gateway = new PromptTerminalGateway(store, { maxConcurrent: 1, heartbeatMs: 60_000 });

  const makeRequest = (viewerId: string, startedAt: number) => Object.assign(new EventEmitter(), {
    url: "/live/prompt/stream",
    headers: {
      authorization: `Bearer ${metadata.ticket}`,
      "x-cptr-viewer-id": viewerId,
      "x-cptr-viewer-started-at": String(startedAt),
    },
    destroyed: false,
  });
  const makeResponse = () => Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    statusCode: 0,
    writeHead(status: number) { this.statusCode = status; },
    flushHeaders() {},
    write() { return true; },
    end() { this.writableEnded = true; },
  });

  const firstRequest = makeRequest("old-card", 100);
  const firstResponse = makeResponse();
  const first = gateway.handleStream(firstRequest as never, firstResponse as never);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(firstResponse.statusCode, 200);

  const secondRequest = makeRequest("new-card", 200);
  const secondResponse = makeResponse();
  const second = gateway.handleStream(secondRequest as never, secondResponse as never);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(firstResponse.writableEnded, true, "new mount must close the stale prompt stream");
  assert.equal(secondResponse.statusCode, 200, "replacement stream must bypass stale-slot 429 rejection");

  secondRequest.emit("close");
  await Promise.all([first, second]);
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

test("renews an expired prompt ticket inside grace without losing replay or browser/workbench routing", () => {
  let now = 1_000;
  const store = new PromptTerminalStore({
    streamingEnabled: true,
    ttlMs: 60_000,
    renewGraceMs: 60_000,
    now: () => now,
    renewUrl: "https://plugin.test/live/prompt/renew",
  } as never);
  const first = store.open();
  assert.equal((first as { renewUrl?: string }).renewUrl, "https://plugin.test/live/prompt/renew");
  assert.equal(store.bindWorkbenchSession(first.ticket, "wbs-ios"), true);
  store.append(first.ticket, {
    type: "browser.surface",
    payload: { action: "open_session", session_id: "brs_ios", state: "HUMAN_CONTROL", owner: "human", epoch: 4 },
  });

  now = first.expiresAt + 1;
  const renewed = (store as unknown as { renew(ticket: string): { ticket: string; expiresAt: number } | null }).renew(first.ticket);

  assert.ok(renewed);
  assert.notEqual(renewed.ticket, first.ticket);
  assert.ok(renewed.expiresAt > now);
  assert.equal(store.ticketForWorkbenchSession("wbs-ios"), renewed.ticket);
  assert.equal(store.ticketForBrowserSession("brs_ios"), renewed.ticket);
  assert.equal(store.replay(renewed.ticket, 0)?.events.length, 1);
  assert.equal(store.replay(first.ticket, 0), null);
});
