import assert from "node:assert/strict";
import test from "node:test";
import {
  eventTerminatesWorkbench,
  initialWorkbenchState,
  isTerminalWorkbenchStatus,
  LiveTargetSession,
  reduceWorkbenchEvent,
  type WorkbenchState,
} from "../web/src/state.js";

const initial: WorkbenchState = {
  status: "CONNECTING",
  lastSequence: 0,
  activity: [],
  terminal: [],
  transcript: [],
  tools: [],
  changes: [],
  evidence: [],
};

test("deduplicates replayed events by monotonic sequence", () => {
  const event = {
    event_id: "evt-1",
    sequence: 1,
    timestamp: "2026-08-25T00:00:00.000Z",
    task_id: "task-1",
    type: "shell.stdout",
    payload: { text: "hello" },
  } as const;
  const once = reduceWorkbenchEvent(initial, event);
  const twice = reduceWorkbenchEvent(once, event);
  assert.equal(once.lastSequence, 1);
  assert.deepEqual(twice, once);
});


test("renders immediate ChatGPT MCP activity without changing the backend event cursor", () => {
  const opened = reduceWorkbenchEvent(initialWorkbenchState(), {
    event_id: "mcp-open",
    sequence: 0,
    timestamp: "2026-08-26T00:00:00Z",
    type: "mcp.tool",
    payload: { tool_name: "cptr_open_live_workbench", summary: "Live Workbench is ready", status: "READY" },
  });
  const live = reduceWorkbenchEvent(opened, {
    event_id: "live-1",
    sequence: 1,
    timestamp: "2026-08-26T00:00:01Z",
    type: "command.started",
    payload: { command_id: "cmd-1", summary: "Running CPTR task", status: "RUNNING" },
  });

  assert.equal(opened.lastSequence, 0);
  assert.equal(opened.status, "CONNECTING");
  assert.equal(opened.tools.length, 1);
  assert.match(opened.transcript[0]?.text ?? "", /ChatGPT → cptr_open_live_workbench/);
  assert.equal(live.lastSequence, 1);
  assert.equal(live.status, "CONNECTING");
});


test("renders sanitized terminal lifecycle rows and rejects duplicate sequences", () => {
  const started = reduceWorkbenchEvent(initialWorkbenchState(), {
    event_id: "event-1",
    sequence: 1,
    timestamp: "2026-08-26T00:00:00Z",
    type: "command.started",
    payload: { command_id: "cmd-1", summary: "Running run_command", status: "RUNNING" },
  });
  const chunked = reduceWorkbenchEvent(started, {
    event_id: "event-2",
    sequence: 2,
    timestamp: "2026-08-26T00:00:01Z",
    type: "terminal.chunk",
    payload: { command_id: "cmd-1", stream: "stdout", text: "first\nsecond" },
  });
  const completed = reduceWorkbenchEvent(chunked, {
    event_id: "event-3",
    sequence: 3,
    timestamp: "2026-08-26T00:00:02Z",
    type: "command.completed",
    payload: { command_id: "cmd-1", status: "COMPLETE" },
  });
  const duplicate = reduceWorkbenchEvent(completed, {
    event_id: "event-4",
    sequence: 3,
    timestamp: "2026-08-26T00:00:03Z",
    type: "terminal.chunk",
    payload: { text: "must not render" },
  });

  assert.equal(completed.transcript.length, 4);
  assert.equal(completed.transcript[1]?.text, "first");
  assert.equal(completed.transcript[2]?.text, "second");
  assert.equal(completed.transcript[3]?.tone, "success");
  assert.equal(duplicate, completed);
});


test("keeps command and tool status scoped below the task lifecycle", () => {
  const running = reduceWorkbenchEvent(initialWorkbenchState(), {
    event_id: "task-started",
    sequence: 1,
    timestamp: "2026-08-26T00:00:00Z",
    type: "task.started",
    payload: { status: "RUNNING" },
  });
  const commandComplete = reduceWorkbenchEvent(running, {
    event_id: "command-complete",
    sequence: 2,
    timestamp: "2026-08-26T00:00:01Z",
    type: "command.completed",
    payload: { command_id: "cmd-1", status: "COMPLETE" },
  });
  const toolComplete = reduceWorkbenchEvent(commandComplete, {
    event_id: "tool-complete",
    sequence: 3,
    timestamp: "2026-08-26T00:00:02Z",
    type: "tool.output",
    payload: { status: "completed", output: "ok" },
  });

  assert.equal(running.status, "RUNNING");
  assert.equal(commandComplete.status, "RUNNING");
  assert.equal(toolComplete.status, "RUNNING");
  assert.equal(eventTerminatesWorkbench({
    event_id: "command-terminal-check",
    sequence: 4,
    timestamp: "2026-08-26T00:00:03Z",
    type: "command.completed",
    payload: { status: "COMPLETE" },
  }), false);
});

test("treats COMPLETE_WITH_TOOL_ERRORS as a terminal non-success task status", () => {
  assert.equal(isTerminalWorkbenchStatus("COMPLETE_WITH_TOOL_ERRORS"), true);
  const completed = reduceWorkbenchEvent(initialWorkbenchState(), {
    event_id: "task-terminal-tool-errors",
    sequence: 1,
    timestamp: "2026-08-26T00:00:03Z",
    type: "task.terminal",
    payload: { status: "COMPLETE_WITH_TOOL_ERRORS" },
  });

  assert.equal(completed.status, "COMPLETE_WITH_TOOL_ERRORS");
  assert.equal(completed.transcript.at(-1)?.tone, "error");
  assert.equal(eventTerminatesWorkbench({
    event_id: "task-terminal-check",
    sequence: 2,
    timestamp: "2026-08-26T00:00:04Z",
    type: "task.terminal",
    payload: { status: "COMPLETE_WITH_TOOL_ERRORS" },
  }), true);
});

test("resets replay cursor and renewal attempts only when the live target changes", () => {
  const session = new LiveTargetSession();
  assert.equal(session.bind("task", "task-a"), true);
  session.cursor = 87;
  session.renewalAttempts = 2;

  assert.equal(session.bind("task", "task-a"), false);
  assert.equal(session.cursor, 87);
  assert.equal(session.renewalAttempts, 2);

  assert.equal(session.bind("task", "task-b"), true);
  assert.equal(session.cursor, 0);
  assert.equal(session.renewalAttempts, 0);
});


test("marks a completed task as awaiting review and adds a review checkpoint row", () => {
  const reviewed = reduceWorkbenchEvent(initialWorkbenchState(), {
    event_id: "event-review",
    sequence: 1,
    timestamp: "2026-08-26T00:00:04Z",
    type: "task.review_ready",
    payload: { status: "REVIEW_REQUIRED", review_status: "REQUIRED" },
  });

  assert.equal(reviewed.status, "REVIEW_REQUIRED");
  assert.equal(reviewed.transcript.length, 1);
  assert.match(reviewed.transcript[0]?.text ?? "", /review the scoped diff/i);
});
