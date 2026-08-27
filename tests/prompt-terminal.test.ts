import assert from "node:assert/strict";
import test from "node:test";
import { PromptTerminalStore, resolveLiveTerminalStreaming } from "../server/prompt-terminal.js";

test("live terminal streaming is disabled unless explicitly enabled", () => {
  assert.equal(resolveLiveTerminalStreaming({}), false);
  assert.equal(resolveLiveTerminalStreaming({ CPTR_LIVE_TERMINAL_STREAMING: "0" }), false);
  assert.equal(resolveLiveTerminalStreaming({ CPTR_LIVE_TERMINAL_STREAMING: "false" }), false);
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
