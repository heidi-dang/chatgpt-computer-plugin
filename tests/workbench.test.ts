import assert from "node:assert/strict";
import test from "node:test";
import {
  appendMcpToolActivity,
  eventTerminatesWorkbench,
  initialWorkbenchState,
  isTerminalWorkbenchStatus,
  LiveTargetSession,
  reduceWorkbenchEvent,
  reduceWorkbenchEvents,
  type WorkbenchState,
} from "../web/src/state.js";

const initial: WorkbenchState = {
  status: "CONNECTING",
  lastSequence: 0,
  transcript: [],
  workers: {},
  workerOrder: [],
};

test("appends MCP tool usage without disturbing the authoritative live-event cursor", () => {
  const withLiveOutput = reduceWorkbenchEvent(initialWorkbenchState(), {
    event_id: "live-7",
    sequence: 7,
    timestamp: "2026-08-27T00:00:00Z",
    type: "terminal.chunk",
    payload: { text: "command output" },
  });
  const activity = {
    event_id: "mcp-read-1",
    timestamp: "2026-08-27T00:00:01Z",
    type: "mcp.tool" as const,
    payload: {
      tool_name: "cptr_code_read_file",
      summary: "Working: Read source file.",
      status: "STARTED",
      arguments_json: "{\n  \"path\": \"server/mcp.ts\"\n}",
    },
  };

  const appended = appendMcpToolActivity(withLiveOutput, activity);
  const duplicate = appendMcpToolActivity(appended, activity);

  assert.equal(appended.lastSequence, 7);
  assert.deepEqual(appended.transcript.slice(-3).map((row) => row.label), ["work", "call", "args"]);
  assert.equal(appended.transcript.at(-2)?.text, "cptr_code_read_file");
  assert.match(appended.transcript.at(-1)?.text ?? "", /server\/mcp\.ts/);
  assert.deepEqual(duplicate, appended);
});

test("renders MCP tool result as result and done rows", () => {
  const next = appendMcpToolActivity(initialWorkbenchState(), {
    event_id: "mcp-result-1",
    timestamp: "2026-08-27T00:00:02Z",
    type: "mcp.tool",
    payload: {
      tool_name: "cptr_list_workspaces",
      summary: "Completed: List CPTR workspaces.",
      status: "COMPLETE",
      result_json: "{\n  \"workspaces\": [{ \"name\": \"tests\" }]\n}",
    },
  });

  assert.deepEqual(next.transcript.map((row) => row.label), ["result", "done"]);
  assert.match(next.transcript[0]?.text ?? "", /workspaces/);
  assert.equal(next.transcript[1]?.tone, "success");
});

test("renders failed MCP tool usage as an error without changing task status", () => {
  const running: WorkbenchState = { status: "RUNNING", lastSequence: 19, transcript: [], workers: {}, workerOrder: [] };
  const next = appendMcpToolActivity(running, {
    event_id: "mcp-failed-1",
    timestamp: "2026-08-27T00:00:02Z",
    type: "mcp.tool",
    payload: { tool_name: "cptr_get_diff", summary: "cptr_get_diff failed.", status: "FAILED" },
  });

  assert.equal(next.status, "RUNNING");
  assert.equal(next.lastSequence, 19);
  assert.equal(next.transcript[0]?.tone, "error");
});

test("batch replay is byte-equivalent to ordered single-event reduction", () => {
  const events = [
    {
      event_id: "batch-start",
      sequence: 1,
      timestamp: "2026-08-27T00:00:00.000Z",
      target: { type: "command" as const, id: "ws-1:cmd-1" },
      type: "command.started",
      payload: { command_id: "cmd-1", summary: "npm test", status: "RUNNING" },
    },
    {
      event_id: "batch-chunk",
      sequence: 2,
      timestamp: "2026-08-27T00:00:01.000Z",
      target: { type: "command" as const, id: "ws-1:cmd-1" },
      type: "terminal.chunk",
      payload: { command_id: "cmd-1", text: "ok" },
    },
    {
      event_id: "batch-complete",
      sequence: 3,
      timestamp: "2026-08-27T00:00:02.000Z",
      target: { type: "command" as const, id: "ws-1:cmd-1" },
      type: "command.completed",
      payload: { command_id: "cmd-1", status: "COMPLETE", exit_code: 0 },
    },
  ];
  const sequential = events.reduce(reduceWorkbenchEvent, initialWorkbenchState());
  const batched = reduceWorkbenchEvents(initialWorkbenchState(), events);
  assert.deepEqual(batched, sequential);
});

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


test("renders CPTR tool lifecycle events while advancing the replay cursor", () => {
  const started = reduceWorkbenchEvent(initialWorkbenchState(), {
    event_id: "tool-start-1",
    sequence: 1,
    timestamp: "2026-08-26T00:00:00Z",
    type: "tool.started",
    payload: { name: "read_file", call_id: "call-1", status: "in_progress" },
  });
  const completed = reduceWorkbenchEvent(started, {
    event_id: "tool-output-1",
    sequence: 2,
    timestamp: "2026-08-26T00:00:01Z",
    type: "tool.output",
    payload: { tool: "read_file", status: "completed", output: "redacted backend output" },
  });

  assert.equal(completed.lastSequence, 2);
  assert.equal(completed.status, "CONNECTING");
  assert.equal(completed.transcript.length, 2);
  assert.equal(completed.transcript[0]?.label, "tool");
  assert.equal(completed.transcript[0]?.text, "read_file started");
  assert.equal(completed.transcript[1]?.text, "read_file completed");
  assert.equal(completed.transcript.some((row) => row.text.includes("redacted backend output")), false);
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

test("uses authoritative command target lifecycle and real exit code", () => {
  const started = reduceWorkbenchEvent(initialWorkbenchState(), {
    event_id: "command-target-start",
    sequence: 1,
    timestamp: "2026-08-26T00:00:00Z",
    target: { type: "command", id: "ws-1:cmd-1" },
    type: "command.started",
    payload: { command_id: "cmd-1", summary: "npm test", status: "RUNNING" },
  });
  const failed = reduceWorkbenchEvent(started, {
    event_id: "command-target-complete",
    sequence: 2,
    timestamp: "2026-08-26T00:00:01Z",
    target: { type: "command", id: "ws-1:cmd-1" },
    type: "command.completed",
    payload: { command_id: "cmd-1", status: "FAILED", exit_code: 2 },
  });

  assert.equal(started.status, "RUNNING");
  assert.equal(failed.status, "FAILED");
  assert.equal(failed.transcript.at(-1)?.tone, "error");
  assert.match(failed.transcript.at(-1)?.text ?? "", /code 2/);
  assert.equal(eventTerminatesWorkbench({
    event_id: "command-target-terminal-check",
    sequence: 3,
    timestamp: "2026-08-26T00:00:02Z",
    target: { type: "command", id: "ws-1:cmd-1" },
    type: "command.completed",
    payload: { status: "COMPLETE", exit_code: 0 },
  }), true);
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

test("bounds long live-terminal history while retaining the newest output", () => {
  let state = initialWorkbenchState();
  for (let sequence = 1; sequence <= 2500; sequence += 1) {
    state = reduceWorkbenchEvent(state, {
      event_id: `long-${sequence}`,
      sequence,
      timestamp: "2026-08-27T00:00:00Z",
      type: "terminal.chunk",
      payload: { text: `line-${sequence}` },
    });
  }

  assert.equal(state.transcript.length, 2000);
  assert.equal(state.transcript[0]?.text, "line-501");
  assert.equal(state.transcript.at(-1)?.text, "line-2500");
  assert.equal(state.lastSequence, 2500);
});

test("normalizes terminal completion status before choosing success tone", () => {
  const state = reduceWorkbenchEvent(initialWorkbenchState(), {
    event_id: "lower-complete",
    sequence: 1,
    timestamp: "2026-08-27T00:00:00Z",
    type: "task.terminal",
    payload: { status: "complete" },
  });

  assert.equal(state.transcript.at(-1)?.tone, "success");
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

  session.cursor = 9;
  assert.equal(session.bind("command", "cmd-1", "ws-1"), true);
  session.cursor = 11;
  assert.equal(session.bind("command", "cmd-1", "ws-1"), false);
  assert.equal(session.cursor, 11);
  assert.equal(session.bind("command", "cmd-1", "ws-2"), true);
  assert.equal(session.cursor, 0);
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
