import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TerminalView } from "../web/src/terminal-view.js";

test("default widget surface renders only the live terminal UI", () => {
  const html = renderToStaticMarkup(React.createElement(TerminalView, {
    rows: [{
      id: "row-1",
      sequence: 7,
      timestamp: "2026-08-27T00:00:00Z",
      tone: "system",
      text: "ChatGPT completed cptr_code_read_file.",
      label: "tool",
    }, {
      id: "row-2",
      sequence: 8,
      timestamp: "2026-08-27T00:00:01Z",
      tone: "stdout",
      text: "CPTR_LIVE_OUTPUT",
    }],
    status: "RUNNING",
    connection: "live",
    targetLabel: "task · task-1",
    canStop: true,
    onStop: () => {},
    onCopy: () => {},
    onPin: () => {},
    onExpand: () => {},
  }));

  assert.match(html, /Live Terminal/);
  assert.match(html, /ChatGPT completed cptr_code_read_file/);
  assert.match(html, />tool</);
  assert.match(html, /CPTR_LIVE_OUTPUT/);
  assert.match(html, /Live redacted terminal transcript/);
  assert.match(html, />Stop</);
  assert.match(html, />Copy</);
  assert.match(html, />Pin</);
  assert.match(html, />Expand</);
  for (const removedSurface of ["Activity", "Tools", "Changes", "Evidence", "Review required", "Steer"]) {
    assert.equal(html.includes(removedSurface), false, `${removedSurface} must not be visible on the default widget surface`);
  }
});

test("terminal empty state contains no synthetic command output", () => {
  const html = renderToStaticMarkup(React.createElement(TerminalView, {
    rows: [],
    status: "READY",
    connection: "activity feed ready",
    targetLabel: "Ready for real CPTR activity",
    canStop: false,
    onStop: () => {},
    onCopy: () => {},
    onPin: () => {},
    onExpand: () => {},
  }));

  assert.match(html, /Terminal ready/);
  assert.match(html, /CPTR tool activity and real command output will appear here/);
  assert.equal(html.includes("$ "), false);
  assert.equal(html.includes("mock"), false);
});
