import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BrowserSurface } from "../web/src/browser-surface.js";
import { DirectWorkersView } from "../web/src/direct-workers-view.js";
import { TerminalView } from "../web/src/terminal-view.js";
import type { DirectWorkerState, TerminalRow } from "../web/src/state.js";

test("server-renders terminal status, bounded output semantics, and accessibility labels", () => {
  const rows: TerminalRow[] = [{
    id: "row-1",
    sequence: 1,
    timestamp: "2026-09-15T00:00:00Z",
    tone: "stdout",
    text: "npm test\nPASS",
  }];
  const html = renderToStaticMarkup(React.createElement(TerminalView, {
    rows,
    status: "RUNNING",
    connection: "live",
    machineLabel: "CPTR",
    targetLabel: "workspace:test",
  }));

  assert.match(html, /aria-label="CPTR live terminal"/);
  assert.match(html, /aria-label="Live terminal output"/);
  assert.match(html, /data-state="live"/);
  assert.match(html, /workspace:test/);
  assert.match(html, /PASS/);
});

test("server-renders released browser state without exposing human-control actions", () => {
  const html = renderToStaticMarkup(React.createElement(BrowserSurface, {
    active: false,
    released: true,
    connection: "offline",
    mode: "DISCONNECTED",
    sessionId: "browser-session-1",
    hostname: "Chrome",
    actionLabel: "Released",
  }));

  assert.match(html, /aria-label="CPTR live browser"/);
  assert.match(html, />RELEASED</);
  assert.match(html, />DISCONNECTED</);
  assert.match(html, /browser session released/);
  assert.doesNotMatch(html, /Return to agent/);
});

test("server-renders Direct Coding Worker tabs and scoped change metadata", () => {
  const worker: DirectWorkerState = {
    workerId: "worker-1",
    workspaceId: "ws-1",
    name: "Worker One",
    responsibility: "Audit runtime",
    repoPath: ".",
    status: "READY",
    summary: "Ready for review",
    changedFileCount: 1,
    changedPaths: ["server/index.ts"],
    activeCommandIds: [],
    recentCommandIds: [],
    activity: [],
  };
  const html = renderToStaticMarkup(React.createElement(DirectWorkersView, {
    workers: { "worker-1": worker },
    workerOrder: ["worker-1"],
    selectedWorkerId: "worker-1",
    selectedTab: "changes",
    connection: "LIVE",
    actionStatus: "Review worker changes",
    changesText: "",
    terminalText: "",
    onSelectWorker: () => undefined,
    onSelectTab: () => undefined,
    onRefreshChanges: () => undefined,
    onRefreshTerminal: () => undefined,
    onPin: () => undefined,
    onExpand: () => undefined,
  }));

  assert.match(html, /aria-label="CPTR Direct Coding Workers"/);
  assert.match(html, /role="tablist"/);
  assert.match(html, /Worker One/);
  assert.match(html, /server\/index\.ts/);
  assert.match(html, /1 currently changed/);
});
