export type WorkbenchEvent = {
  event_id: string;
  sequence: number;
  timestamp: string;
  task_id?: string | null;
  monitor_id?: string | null;
  worker_task_id?: string | null;
  type: string;
  payload: Record<string, unknown>;
};

export type WorkbenchState = {
  status: string;
  lastSequence: number;
  activity: WorkbenchEvent[];
  terminal: WorkbenchEvent[];
  tools: WorkbenchEvent[];
  changes: WorkbenchEvent[];
  evidence: WorkbenchEvent[];
  error?: string;
};

const MAX_EVENTS = 120;

function bounded(events: WorkbenchEvent[]): WorkbenchEvent[] {
  return events.length <= MAX_EVENTS ? events : events.slice(events.length - MAX_EVENTS);
}

function nextStatus(event: WorkbenchEvent, current: string): string {
  const status = typeof event.payload.status === "string" ? event.payload.status : undefined;
  if (event.type.endsWith(".terminal") && status) return status;
  if (event.type === "task.started" || event.type === "monitor.started") return "RUNNING";
  if (event.type === "task.cancelled" || event.type === "monitor.cancelled") return "CANCELLED";
  if (event.type === "task.completed" || event.type === "monitor.completed") return "COMPLETE";
  return status ?? current;
}

export function reduceWorkbenchEvent(state: WorkbenchState, event: WorkbenchEvent): WorkbenchState {
  if (!Number.isSafeInteger(event.sequence) || event.sequence <= state.lastSequence) return state;
  const next = { ...state, lastSequence: event.sequence, status: nextStatus(event, state.status) };
  next.activity = bounded([...state.activity, event]);

  if (event.type.startsWith("tool.") || event.type.startsWith("shell.")) {
    next.tools = bounded([...state.tools, event]);
  }
  if (event.type.startsWith("file.") || event.type === "git.diff") {
    next.changes = bounded([...state.changes, event]);
  }
  if (event.type.startsWith("evidence.") || event.type.startsWith("verification.")) {
    next.evidence = bounded([...state.evidence, event]);
  }
  if (event.type.endsWith(".terminal") || ["task.completed", "task.cancelled", "monitor.completed", "monitor.cancelled"].includes(event.type)) {
    next.terminal = bounded([...state.terminal, event]);
  }
  return next;
}

export function initialWorkbenchState(): WorkbenchState {
  return {
    status: "CONNECTING",
    lastSequence: 0,
    activity: [],
    terminal: [],
    tools: [],
    changes: [],
    evidence: [],
  };
}
