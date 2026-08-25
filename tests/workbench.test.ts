import assert from "node:assert/strict";
import test from "node:test";
import { reduceWorkbenchEvent, type WorkbenchState } from "../web/src/state.js";

const initial: WorkbenchState = {
  status: "CONNECTING",
  lastSequence: 0,
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
