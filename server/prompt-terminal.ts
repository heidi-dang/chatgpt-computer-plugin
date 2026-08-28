import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { WidgetStreamMetadata } from "./live-tickets.js";

type Environment = Record<string, string | undefined>;

export function resolveLiveTerminalStreaming(env: Environment = process.env): boolean {
  return ["1", "true", "on", "yes"].includes(
    (env.CPTR_LIVE_TERMINAL_STREAMING ?? "").trim().toLowerCase(),
  );
}

export type PromptActivityEvent = {
  event_id: string;
  sequence: number;
  timestamp: string;
  type: "mcp.tool";
  payload: {
    tool_name: string;
    summary: string;
    status: string;
    arguments_json?: string;
    result_json?: string;
    error?: string;
  };
};

export type PromptDirectWorkerEvent = {
  event_id: string;
  sequence: number;
  timestamp: string;
  type: "direct.worker";
  payload: {
    worker_id: string;
    workspace_id?: string;
    name?: string;
    responsibility?: string;
    repo_path?: string;
    status?: string;
    summary?: string;
    changed_file_count?: number;
    changed_paths?: string[];
    active_command_ids?: string[];
    recent_command_ids?: string[];
  };
};

export type PromptLiveBindingEvent = {
  event_id: string;
  sequence: number;
  timestamp: string;
  type: "live.bind";
  payload: {
    live: WidgetStreamMetadata;
  };
};

export type PromptTerminalEvent = PromptActivityEvent | PromptDirectWorkerEvent | PromptLiveBindingEvent;

export type PromptTerminalMetadata = {
  ticket: string;
  streamUrl: string;
  snapshotUrl: string;
  expiresAt: number;
  streamingEnabled: boolean;
};

type PendingPromptEvent =
  | Omit<PromptActivityEvent, "event_id" | "sequence" | "timestamp">
  | Omit<PromptDirectWorkerEvent, "event_id" | "sequence" | "timestamp">
  | Omit<PromptLiveBindingEvent, "event_id" | "sequence" | "timestamp">;

type PromptSession = {
  ticket: string;
  expiresAt: number;
  lastSequence: number;
  events: PromptTerminalEvent[];
  listeners: Set<(event: PromptTerminalEvent) => void>;
  allowDelegate: boolean;
};

type PromptStoreOptions = {
  now?: () => number;
  ttlMs?: number;
  maxSessions?: number;
  maxEvents?: number;
  streamUrl?: string;
  snapshotUrl?: string;
  streamingEnabled?: boolean;
};

export class PromptTerminalStore {
  private readonly sessions = new Map<string, PromptSession>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxSessions: number;
  private readonly maxEvents: number;
  private readonly streamUrl: string;
  private readonly snapshotUrl: string;
  private readonly streamingEnabledValue: boolean;

  constructor(options: PromptStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = Math.max(60_000, options.ttlMs ?? 30 * 60_000);
    this.maxSessions = Math.max(1, options.maxSessions ?? 256);
    this.maxEvents = Math.max(16, options.maxEvents ?? 2_000);
    this.streamUrl = options.streamUrl ?? "/live/prompt/stream";
    this.snapshotUrl = options.snapshotUrl ?? "/live/prompt/snapshot";
    this.streamingEnabledValue = options.streamingEnabled ?? true;
  }

  get streamingEnabled(): boolean {
    return this.streamingEnabledValue;
  }

  get size(): number {
    this.prune();
    return this.sessions.size;
  }

  open(options: { allowDelegate?: boolean } = {}): PromptTerminalMetadata {
    this.prune();
    while (this.sessions.size >= this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (typeof oldest !== "string") break;
      this.remove(oldest);
    }
    const ticket = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + this.ttlMs;
    this.sessions.set(ticket, {
      ticket,
      expiresAt,
      lastSequence: 0,
      events: [],
      listeners: new Set(),
      allowDelegate: options.allowDelegate === true,
    });
    return {
      ticket,
      expiresAt,
      streamUrl: this.streamUrl,
      snapshotUrl: this.snapshotUrl,
      streamingEnabled: this.streamingEnabledValue,
    };
  }

  allowsDelegation(ticket: string | null | undefined): boolean {
    if (!ticket) return false;
    return this.getSession(ticket)?.allowDelegate === true;
  }

  append(ticket: string | null | undefined, event: PendingPromptEvent): PromptTerminalEvent | null {
    if (!this.streamingEnabledValue || !ticket) return null;
    const session = this.getSession(ticket);
    if (!session) return null;
    session.lastSequence += 1;
    const fullEvent = {
      ...event,
      event_id: `prompt-${randomUUID()}`,
      sequence: session.lastSequence,
      timestamp: new Date(this.now()).toISOString(),
    } as PromptTerminalEvent;
    session.events.push(fullEvent);
    if (session.events.length > this.maxEvents) {
      session.events.splice(0, session.events.length - this.maxEvents);
    }
    for (const listener of session.listeners) listener(fullEvent);
    return fullEvent;
  }

  replay(ticket: string, after = 0): { events: PromptTerminalEvent[]; last_sequence: number; expires_at: number } | null {
    const session = this.getSession(ticket);
    if (!session) return null;
    return {
      events: session.events.filter((event) => event.sequence > after),
      last_sequence: session.lastSequence,
      expires_at: session.expiresAt,
    };
  }

  subscribe(ticket: string, listener: (event: PromptTerminalEvent) => void): (() => void) | null {
    if (!this.streamingEnabledValue) return null;
    const session = this.getSession(ticket);
    if (!session) return null;
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  }

  revoke(ticket: string): void {
    this.remove(ticket);
  }

  private getSession(ticket: string): PromptSession | null {
    const session = this.sessions.get(ticket);
    if (!session) return null;
    if (session.expiresAt <= this.now()) {
      this.remove(ticket);
      return null;
    }
    return session;
  }

  private prune(): void {
    const now = this.now();
    for (const [ticket, session] of this.sessions) {
      if (session.expiresAt <= now) this.remove(ticket);
    }
  }

  private remove(ticket: string): void {
    const session = this.sessions.get(ticket);
    if (!session) return;
    session.listeners.clear();
    this.sessions.delete(ticket);
  }
}

function bearerValue(request: IncomingMessage): string | null {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ")) return null;
  const token = value.slice("Bearer ".length).trim();
  return token || null;
}

function parseCursor(value: string | null | undefined): number | null {
  const raw = value ?? "0";
  if (!/^\d{1,12}$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function waitForDrain(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  if (request.destroyed || response.destroyed) return false;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      response.removeListener("drain", onDrain);
      request.removeListener("close", onClose);
      response.removeListener("close", onClose);
      resolve(value);
    };
    const onDrain = () => finish(true);
    const onClose = () => finish(false);
    response.once("drain", onDrain);
    request.once("close", onClose);
    response.once("close", onClose);
  });
}

export class PromptTerminalGateway {
  private activeStreams = 0;

  constructor(
    private readonly store: PromptTerminalStore,
    private readonly limits: { maxConcurrent?: number; maxBytes?: number; maxDurationMs?: number; heartbeatMs?: number } = {},
  ) {}

  handleSnapshot(request: IncomingMessage, response: ServerResponse): void {
    const ticket = bearerValue(request);
    const url = new URL(request.url ?? "/", "http://localhost");
    const after = parseCursor(url.searchParams.get("after"));
    if (url.pathname !== "/live/prompt/snapshot" || !ticket) {
      this.json(response, 404, { error: "prompt terminal snapshot not found" });
      return;
    }
    if (after === null) {
      this.json(response, 400, { error: "invalid prompt-event cursor" });
      return;
    }
    const replay = this.store.replay(ticket, after);
    if (!replay) {
      this.json(response, 401, { error: "prompt terminal ticket is invalid or expired" }, { "www-authenticate": "Bearer" });
      return;
    }
    this.json(response, 200, { replay });
  }

  async handleStream(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const ticket = bearerValue(request);
    const url = new URL(request.url ?? "/", "http://localhost");
    const headerCursor = Array.isArray(request.headers["last-event-id"])
      ? request.headers["last-event-id"][0]
      : request.headers["last-event-id"];
    const after = parseCursor(headerCursor ?? url.searchParams.get("after"));
    if (url.pathname !== "/live/prompt/stream" || !ticket) {
      this.json(response, 404, { error: "prompt terminal stream not found" });
      return;
    }
    if (after === null) {
      this.json(response, 400, { error: "invalid prompt-event cursor" });
      return;
    }
    const maxConcurrent = this.limits.maxConcurrent ?? 16;
    if (this.activeStreams >= maxConcurrent) {
      this.json(response, 429, { error: "prompt terminal stream capacity reached" });
      return;
    }
    const initial = this.store.replay(ticket, after);
    if (!initial) {
      this.json(response, 401, { error: "prompt terminal ticket is invalid or expired" }, { "www-authenticate": "Bearer" });
      return;
    }

    this.activeStreams += 1;
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-store",
      "referrer-policy": "no-referrer",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    const queue = [...initial.events];
    let wake: (() => void) | null = null;
    let closed = false;
    let bytes = 0;
    const deadline = Date.now() + (this.limits.maxDurationMs ?? 10 * 60_000);
    const maxBytes = this.limits.maxBytes ?? 1_048_576;
    const heartbeatMs = this.limits.heartbeatMs ?? 15_000;
    const unsubscribe = this.store.subscribe(ticket, (event) => {
      queue.push(event);
      wake?.();
      wake = null;
    });
    if (!unsubscribe) {
      this.activeStreams -= 1;
      response.end();
      return;
    }
    const close = () => {
      closed = true;
      wake?.();
      wake = null;
    };
    request.once("close", close);
    response.once("close", close);

    const write = async (chunk: string): Promise<boolean> => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes || closed) return false;
      if (response.write(chunk)) return true;
      return await waitForDrain(request, response);
    };

    try {
      let cursor = after;
      while (!closed && Date.now() < deadline) {
        while (queue.length && !closed) {
          const event = queue.shift()!;
          if (event.sequence <= cursor) continue;
          cursor = event.sequence;
          const frame = `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
          if (!(await write(frame))) return;
        }
        if (closed) return;
        const remaining = Math.min(heartbeatMs, Math.max(0, deadline - Date.now()));
        if (remaining <= 0) return;
        const signalled = await new Promise<boolean>((resolve) => {
          let settled = false;
          const finish = (value: boolean) => {
            if (settled) return;
            settled = true;
            if (wake === onWake) wake = null;
            clearTimeout(timer);
            resolve(value);
          };
          const onWake = () => finish(true);
          wake = onWake;
          const timer = setTimeout(() => finish(false), remaining);
        });
        if (!signalled && !closed && !(await write(": prompt-terminal\n\n"))) return;
      }
    } finally {
      unsubscribe();
      request.removeListener("close", close);
      response.removeListener("close", close);
      this.activeStreams -= 1;
      if (!response.writableEnded) response.end();
    }
  }

  private json(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
    response.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...headers,
    });
    response.end(JSON.stringify(value));
  }
}
