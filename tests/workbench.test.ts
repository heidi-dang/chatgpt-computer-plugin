import assert from "node:assert/strict";
import test from "node:test";
import { reduceWorkbenchEvent, type WorkbenchState } from "../web/src/state.js";

const initial: WorkbenchState = {
  status: "CONNECTING",
  phase: "CONNECTING",
  lastSequence: 0,
  startedAt: null,
  workerTaskId: null,
  activeOperation: null,
  lastEvent: null,
  controlDelivery: null,
  activity: [],
  terminal: [],
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

test("derives progress, worker identity, and active operation from live events", () => {
  const started = reduceWorkbenchEvent(initial, {
    event_id: "evt-start",
    sequence: 1,
    timestamp: "2026-08-25T00:00:00.000Z",
    task_id: "task-1",
    worker_task_id: "worker-1",
    type: "task.started",
    payload: { status: "RUNNING" },
  });
  const tool = reduceWorkbenchEvent(started, {
    event_id: "evt-tool",
    sequence: 2,
    timestamp: "2026-08-25T00:00:01.000Z",
    task_id: "task-1",
    worker_task_id: "worker-1",
    type: "tool.started",
    payload: { tool: "run_command", operation: "pytest tests/test_runtime.py" },
  });

  assert.equal(started.phase, "STARTING");
  assert.equal(tool.phase, "WORKING");
  assert.equal(tool.workerTaskId, "worker-1");
  assert.equal(tool.activeOperation, "pytest tests/test_runtime.py");
  assert.equal(tool.startedAt, "2026-08-25T00:00:00.000Z");
  assert.equal(tool.lastEvent?.event_id, "evt-tool");
});

test("tracks control delivery and verification without inventing completion", () => {
  const queued = reduceWorkbenchEvent(initial, {
    event_id: "evt-control-queued",
    sequence: 1,
    timestamp: "2026-08-25T00:00:00.000Z",
    task_id: "task-1",
    type: "control.queued",
    payload: { status: "QUEUED", control_message_id: "control-1" },
  });
  const verifying = reduceWorkbenchEvent(queued, {
    event_id: "evt-verifying",
    sequence: 2,
    timestamp: "2026-08-25T00:00:02.000Z",
    task_id: "task-1",
    type: "verification.started",
    payload: { status: "VERIFYING", operation: "git diff --check" },
  });
  const consumed = reduceWorkbenchEvent(verifying, {
    event_id: "evt-control-consumed",
    sequence: 3,
    timestamp: "2026-08-25T00:00:03.000Z",
    task_id: "task-1",
    type: "control.consumed",
    payload: { status: "CONSUMED", control_message_id: "control-1" },
  });

  assert.deepEqual(queued.controlDelivery, { controlMessageId: "control-1", status: "QUEUED" });
  assert.equal(verifying.phase, "VERIFYING");
  assert.equal(verifying.activeOperation, "git diff --check");
  assert.deepEqual(consumed.controlDelivery, { controlMessageId: "control-1", status: "CONSUMED" });
  assert.notEqual(consumed.status, "COMPLETE");
});

test("terminal events close the active operation and cannot be replaced by stale replays", () => {
  const running = reduceWorkbenchEvent(initial, {
    event_id: "evt-tool",
    sequence: 1,
    timestamp: "2026-08-25T00:00:00.000Z",
    task_id: "task-1",
    type: "tool.started",
    payload: { tool: "write_file" },
  });
  const complete = reduceWorkbenchEvent(running, {
    event_id: "evt-complete",
    sequence: 2,
    timestamp: "2026-08-25T00:00:01.000Z",
    task_id: "task-1",
    type: "task.terminal",
    payload: { status: "COMPLETE" },
  });
  const stale = reduceWorkbenchEvent(complete, {
    event_id: "evt-stale",
    sequence: 1,
    timestamp: "2026-08-25T00:00:00.500Z",
    task_id: "task-1",
    type: "tool.started",
    payload: { tool: "run_command" },
  });

  assert.equal(complete.phase, "COMPLETE");
  assert.equal(complete.activeOperation, null);
  assert.deepEqual(stale, complete);
});
