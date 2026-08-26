import assert from "node:assert/strict";
import test from "node:test";
import { initialWorkbenchState, reduceWorkbenchEvent, type WorkbenchState } from "../web/src/state.js";

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
