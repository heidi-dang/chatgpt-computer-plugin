export type WorkbenchEvent = {
  version?: number;
  event_id: string;
  sequence: number;
  timestamp: string;
  type: string;
  payload?: Record<string, unknown>;
  task_id?: string | null;
  monitor_id?: string | null;
  worker_task_id?: string | null;
  target?: { type: "task" | "monitor"; id: string };
  redaction_applied?: boolean;
};

export type TerminalRow = {
  id: string;
  sequence: number;
  timestamp: string;
  tone: "prompt" | "stdout" | "stderr" | "system" | "success" | "error";
  text: string;
  commandId?: string;
};

export type WorkbenchState = {
  status: string;
  lastSequence: number;
  activity: WorkbenchEvent[];
  terminal: WorkbenchEvent[];
  transcript: TerminalRow[];
  tools: WorkbenchEvent[];
  changes: WorkbenchEvent[];
  evidence: WorkbenchEvent[];
};

const MAX_EVENTS = 400;
const MAX_TERMINAL_ROWS = 2_000;

function bounded<T>(items: T[], limit = MAX_EVENTS): T[] {
  return items.length > limit ? items.slice(items.length - limit) : items;
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function terminalRows(event: WorkbenchEvent): TerminalRow[] {
  const payload = event.payload ?? {};
  const commandId = stringValue(payload.command_id) || undefined;
  if (event.type === "command.started") {
    return [{
      id: `${event.event_id}:start`,
      sequence: event.sequence,
      timestamp: event.timestamp,
      tone: "prompt",
      commandId,
      text: stringValue(payload.summary, stringValue(payload.tool_name, "Running command")),
    }];
  }
  if (event.type === "terminal.chunk" || event.type === "shell.stdout") {
    const text = stringValue(payload.text, stringValue(payload.output));
    const tone = stringValue(payload.stream) === "stderr" ? "stderr" : "stdout";
    return text.split(/\r?\n/).map((line, index) => ({
      id: `${event.event_id}:${index}`,
      sequence: event.sequence,
      timestamp: event.timestamp,
      tone,
      commandId,
      text: line || " ",
    }));
  }
  if (event.type === "command.completed") {
    const status = stringValue(payload.status, "COMPLETE");
    return [{
      id: `${event.event_id}:complete`,
      sequence: event.sequence,
      timestamp: event.timestamp,
      tone: status === "COMPLETE" ? "success" : "error",
      commandId,
      text: `Command ${status.toLowerCase()}.`,
    }];
  }
  if (event.type.endsWith(".terminal") || event.type === "session.terminal") {
    const status = stringValue(payload.status, "COMPLETE");
    return [{
      id: `${event.event_id}:terminal`,
      sequence: event.sequence,
      timestamp: event.timestamp,
      tone: ["COMPLETE", "COMPLETED"].includes(status) ? "success" : "error",
      text: `Session ${status.toLowerCase()}.`,
    }];
  }
  if (event.type === "agent.phase") {
    return [{
      id: `${event.event_id}:phase`,
      sequence: event.sequence,
      timestamp: event.timestamp,
      tone: "system",
      text: stringValue(payload.summary, stringValue(payload.phase, "Agent activity")),
    }];
  }
  return [];
}

export function initialWorkbenchState(): WorkbenchState {
  return {
    status: "CONNECTING",
    lastSequence: 0,
    activity: [],
    terminal: [],
    transcript: [],
    tools: [],
    changes: [],
    evidence: [],
  };
}

export function reduceWorkbenchEvent(state: WorkbenchState, event: WorkbenchEvent): WorkbenchState {
  if (!Number.isFinite(event.sequence) || event.sequence <= state.lastSequence) return state;
  const payload = event.payload ?? {};
  const status = stringValue(payload.status).toUpperCase();
  const next: WorkbenchState = {
    ...state,
    lastSequence: event.sequence,
    activity: bounded([...state.activity, event]),
  };
  if (status) next.status = status;
  if (event.type.startsWith("tool.")) next.tools = bounded([...state.tools, event]);
  if (event.type.startsWith("file.") || event.type.startsWith("diff.")) next.changes = bounded([...state.changes, event]);
  if (event.type.startsWith("evidence.") || event.type.startsWith("verification.")) {
    next.evidence = bounded([...state.evidence, event]);
  }
  const rows = terminalRows(event);
  if (rows.length) {
    next.terminal = bounded([...state.terminal, event]);
    next.transcript = bounded([...state.transcript, ...rows], MAX_TERMINAL_ROWS);
  }
  return next;
}
