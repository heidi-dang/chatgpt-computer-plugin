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
  phase: string;
  lastSequence: number;
  startedAt: string | null;
  workerTaskId: string | null;
  activeOperation: string | null;
  lastEvent: WorkbenchEvent | null;
  controlDelivery: { controlMessageId: string | null; status: string } | null;
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

function eventText(event: WorkbenchEvent): string | null {
  const payload = event.payload ?? {};
  for (const key of ["operation", "command", "tool", "name"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 240);
  }
  if (event.type.startsWith("tool.") || event.type.startsWith("shell.")) return event.type;
  return null;
}

function nextPhase(event: WorkbenchEvent, current: string, status: string): string {
  if (["COMPLETE", "CANCELLED", "FAILED", "BLOCKED"].includes(status)) return status;
  if (event.type === "task.started" || event.type === "monitor.started") return "STARTING";
  if (event.type.startsWith("verification.") || event.type.startsWith("evidence.")) return "VERIFYING";
  if (event.type.startsWith("tool.") || event.type.startsWith("shell.") || event.type.startsWith("file.")) return "WORKING";
  return current;
}

function nextControlDelivery(event: WorkbenchEvent, current: WorkbenchState["controlDelivery"]): WorkbenchState["controlDelivery"] {
  if (!event.type.startsWith("control.")) return current;
  const payload = event.payload ?? {};
  const controlMessageId = typeof payload.control_message_id === "string"
    ? payload.control_message_id
    : current?.controlMessageId ?? null;
  const status = typeof payload.status === "string"
    ? payload.status
    : typeof payload.delivery_status === "string"
      ? payload.delivery_status
      : event.type.slice("control.".length).toUpperCase();
  return { controlMessageId, status };
}

export function reduceWorkbenchEvent(state: WorkbenchState, event: WorkbenchEvent): WorkbenchState {
  if (!Number.isSafeInteger(event.sequence) || event.sequence <= state.lastSequence) return state;
  const status = nextStatus(event, state.status);
  const terminal = ["COMPLETE", "CANCELLED", "FAILED", "BLOCKED"].includes(status);
  const next = {
    ...state,
    lastSequence: event.sequence,
    status,
    phase: nextPhase(event, state.phase, status),
    startedAt: state.startedAt ?? ((event.type === "task.started" || event.type === "monitor.started") ? event.timestamp : null),
    workerTaskId: event.worker_task_id ?? state.workerTaskId,
    activeOperation: terminal ? null : (eventText(event) ?? state.activeOperation),
    lastEvent: event,
    controlDelivery: nextControlDelivery(event, state.controlDelivery),
  };
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
}
