import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { LiveTicketCodec } from "./live-ticket-codec.js";
import { LiveViewerRegistry, liveViewerIdentity } from "./live-viewers.js";
import type { LiveTarget, WidgetStreamMetadata } from "./live-tickets.js";

type Environment = Record<string, string | undefined>;

export function resolveLiveTerminalStreaming(env: Environment = process.env): boolean {
  return !["0", "false", "off", "no"].includes(
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

export type PromptBrowserSurfaceEvent = {
  event_id: string;
  sequence: number;
  timestamp: string;
  type: "browser.surface";
  payload: {
    action: string;
    device_id?: string;
    session_id?: string;
    state?: string;
    owner?: string;
    epoch?: number;
    hostname?: string;
  };
};

export type PromptTerminalEvent = PromptActivityEvent | PromptDirectWorkerEvent | PromptLiveBindingEvent | PromptBrowserSurfaceEvent;

export type PromptTerminalMetadata = {
  ticket: string;
  streamUrl: string;
  snapshotUrl: string;
  renewUrl: string;
  browserFrameUrl: string;
  browserInputUrl: string;
  expiresAt: number;
  streamingEnabled: boolean;
};

type PendingPromptEvent =
  | Omit<PromptActivityEvent, "event_id" | "sequence" | "timestamp">
  | Omit<PromptDirectWorkerEvent, "event_id" | "sequence" | "timestamp">
  | Omit<PromptLiveBindingEvent, "event_id" | "sequence" | "timestamp">
  | Omit<PromptBrowserSurfaceEvent, "event_id" | "sequence" | "timestamp">;

type PromptTicketClaims = {
  sessionId: string;
  workbenchSessionId?: string;
  generation: number;
  expiresAt: number;
  renewUntil: number;
};

type PromptSession = {
  sessionId: string;
  workbenchSessionId?: string;
  generation: number;
  ticket: string;
  expiresAt: number;
  renewUntil: number;
  lastSequence: number;
  events: PromptTerminalEvent[];
  listeners: Set<(event: PromptTerminalEvent) => void>;
  allowDelegate: boolean;
  allowSecretWrite: boolean;
  browserSessionIds: Set<string>;
  liveTargetKeys: Set<string>;
};

function liveTargetKey(target: LiveTarget): string {
  return target.targetType === "command"
    ? `command:${target.workspaceId}:${target.targetId}`
    : `${target.targetType}:${target.targetId}`;
}

type PromptStoreOptions = {
  now?: () => number;
  ttlMs?: number;
  renewGraceMs?: number;
  maxSessions?: number;
  maxEvents?: number;
  streamUrl?: string;
  snapshotUrl?: string;
  renewUrl?: string;
  browserFrameUrl?: string;
  browserInputUrl?: string;
  streamingEnabled?: boolean;
  ticketSecret?: string | Buffer;
};

export class PromptTerminalStore {
  private readonly sessions = new Map<string, PromptSession>();
  private readonly sessionsById = new Map<string, string>();
  private readonly revokedUntil = new Map<string, number>();
  private readonly workbenchTickets = new Map<string, string>();
  private readonly browserSessionTickets = new Map<string, string>();
  private readonly liveTargetTickets = new Map<string, string>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly renewGraceMs: number;
  private readonly maxSessions: number;
  private readonly maxEvents: number;
  private readonly streamUrl: string;
  private readonly snapshotUrl: string;
  private readonly renewUrl: string;
  private readonly browserFrameUrl: string;
  private readonly browserInputUrl: string;
  private readonly streamingEnabledValue: boolean;
  private readonly codec: LiveTicketCodec;

  constructor(options: PromptStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = Math.max(60_000, options.ttlMs ?? 30 * 60_000);
    this.renewGraceMs = Math.max(0, options.renewGraceMs ?? this.ttlMs);
    this.maxSessions = Math.max(1, options.maxSessions ?? 256);
    this.maxEvents = Math.max(16, options.maxEvents ?? 2_000);
    this.streamUrl = options.streamUrl ?? "/live/prompt/stream";
    this.snapshotUrl = options.snapshotUrl ?? "/live/prompt/snapshot";
    this.renewUrl = options.renewUrl ?? "/live/prompt/renew";
    this.browserFrameUrl = options.browserFrameUrl ?? "/live/prompt/browser-frame";
    this.browserInputUrl = options.browserInputUrl ?? "/live/prompt/browser-input";
    this.streamingEnabledValue = options.streamingEnabled ?? true;
    this.codec = new LiveTicketCodec(options.ticketSecret);
  }

  get streamingEnabled(): boolean {
    return this.streamingEnabledValue;
  }

  get size(): number {
    this.prune();
    return this.sessions.size;
  }

  open(options: { allowDelegate?: boolean; allowSecretWrite?: boolean; workbenchSessionId?: string } = {}): PromptTerminalMetadata {
    this.prune();
    const existingTicket = options.workbenchSessionId
      ? this.workbenchTickets.get(options.workbenchSessionId)
      : undefined;
    const existing = existingTicket ? this.sessions.get(existingTicket) : undefined;
    if (existing && existing.renewUntil > this.now()) {
      this.touch(existing);
      existing.allowDelegate = options.allowDelegate === true;
      existing.allowSecretWrite = options.allowSecretWrite === true;
      return this.metadata(existing);
    }
    while (this.sessions.size >= this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (typeof oldest !== "string") break;
      this.remove(oldest);
    }
    const expiresAt = this.now() + this.ttlMs;
    const claims: PromptTicketClaims = {
      sessionId: randomBytes(18).toString("base64url"),
      ...(options.workbenchSessionId ? { workbenchSessionId: options.workbenchSessionId } : {}),
      generation: 0,
      expiresAt,
      renewUntil: expiresAt + this.renewGraceMs,
    };
    const ticket = this.codec.seal("prompt", claims);
    const session: PromptSession = {
      ...claims,
      ticket,
      lastSequence: 0,
      events: [],
      listeners: new Set(),
      allowDelegate: options.allowDelegate === true,
      allowSecretWrite: options.allowSecretWrite === true,
      browserSessionIds: new Set(),
      liveTargetKeys: new Set(),
    };
    this.sessions.set(ticket, session);
    this.sessionsById.set(session.sessionId, ticket);
    if (options.workbenchSessionId) this.workbenchTickets.set(options.workbenchSessionId, ticket);
    return this.metadata(session);
  }

  resumeWorkbenchSession(
    workbenchSessionId: string | null | undefined,
    options: { allowDelegate?: boolean; allowSecretWrite?: boolean } = {},
  ): PromptTerminalMetadata | null {
    const ticket = this.ticketForWorkbenchSession(workbenchSessionId);
    if (!ticket) return null;
    const session = this.sessions.get(ticket);
    if (!session || session.renewUntil <= this.now()) return null;
    this.touch(session);
    session.allowDelegate = options.allowDelegate === true;
    session.allowSecretWrite = options.allowSecretWrite === true;
    return this.metadata(session);
  }

  allowsDelegation(ticket: string | null | undefined): boolean {
    if (!ticket) return false;
    return this.getSession(ticket)?.allowDelegate === true;
  }

  allowsSecretWrite(ticket: string | null | undefined): boolean {
    if (!ticket) return false;
    return this.getSession(ticket)?.allowSecretWrite === true;
  }

  allowsBrowserSession(ticket: string | null | undefined, sessionId: string): boolean {
    if (!ticket || !sessionId) return false;
    const session = this.getSession(ticket);
    if (!session) return false;
    this.touch(session);
    return session.browserSessionIds.has(sessionId);
  }

  bindWorkbenchSession(ticket: string | null | undefined, workbenchSessionId: string | null | undefined): boolean {
    if (!ticket || !workbenchSessionId) return false;
    const session = this.getSession(ticket);
    if (!session) return false;
    session.workbenchSessionId = workbenchSessionId;
    this.workbenchTickets.set(workbenchSessionId, ticket);
    return true;
  }

  ticketForWorkbenchSession(workbenchSessionId: string | null | undefined): string | null {
    if (!workbenchSessionId) return null;
    const ticket = this.workbenchTickets.get(workbenchSessionId);
    if (!ticket) return null;
    const session = this.sessions.get(ticket);
    if (!session || session.renewUntil <= this.now()) {
      this.workbenchTickets.delete(workbenchSessionId);
      return null;
    }
    return ticket;
  }

  ticketForLiveTarget(target: LiveTarget | null | undefined): string | null {
    if (!target) return null;
    const key = liveTargetKey(target);
    const ticket = this.liveTargetTickets.get(key);
    if (!ticket) return null;
    const session = this.getSession(ticket);
    if (!session || !session.liveTargetKeys.has(key)) {
      this.liveTargetTickets.delete(key);
      return null;
    }
    return ticket;
  }

  ticketForBrowserSession(browserSessionId: string | null | undefined): string | null {
    if (!browserSessionId) return null;
    const ticket = this.browserSessionTickets.get(browserSessionId);
    if (!ticket) return null;
    const session = this.getSession(ticket);
    if (!session || !session.browserSessionIds.has(browserSessionId)) {
      this.browserSessionTickets.delete(browserSessionId);
      return null;
    }
    return ticket;
  }

  append(ticket: string | null | undefined, event: PendingPromptEvent): PromptTerminalEvent | null {
    if (!this.streamingEnabledValue || !ticket) return null;
    const session = this.getSession(ticket);
    if (!session) return null;
    if (event.type === "live.bind") {
      const key = liveTargetKey(event.payload.live);
      const previousTicket = this.liveTargetTickets.get(key);
      if (previousTicket && previousTicket !== ticket) {
        this.sessions.get(previousTicket)?.liveTargetKeys.delete(key);
      }
      session.liveTargetKeys.add(key);
      this.liveTargetTickets.set(key, ticket);
      while (session.liveTargetKeys.size > 64) {
        const oldest = session.liveTargetKeys.values().next().value;
        if (typeof oldest !== "string") break;
        session.liveTargetKeys.delete(oldest);
        if (this.liveTargetTickets.get(oldest) === ticket) this.liveTargetTickets.delete(oldest);
      }
    }
    if (event.type === "browser.surface") {
      const sessionId = event.payload.session_id;
      if (typeof sessionId === "string" && sessionId) {
        session.browserSessionIds.add(sessionId);
        this.browserSessionTickets.set(sessionId, ticket);
        while (session.browserSessionIds.size > 16) {
          const oldest = session.browserSessionIds.values().next().value;
          if (typeof oldest !== "string") break;
          session.browserSessionIds.delete(oldest);
          if (this.browserSessionTickets.get(oldest) === ticket) this.browserSessionTickets.delete(oldest);
        }
      }
    }
    session.lastSequence += 1;
    const fullEvent = {
      ...event,
      event_id: `prompt-${randomUUID()}`,
      sequence: session.lastSequence,
      timestamp: new Date(this.now()).toISOString(),
    } as PromptTerminalEvent;
    session.events.push(fullEvent);
    if (session.events.length > this.maxEvents) {
      // Trim to 75% of max to reduce splice frequency. Each splice is O(n)
      // because it shifts all remaining elements. By trimming to 75%, we
      // amortize the cost over more appends before the next trim.
      const keepCount = Math.floor(this.maxEvents * 0.75);
      session.events.splice(0, session.events.length - keepCount);
    }
    for (const listener of session.listeners) listener(fullEvent);
    return fullEvent;
  }

  replay(ticket: string, after = 0): { events: PromptTerminalEvent[]; last_sequence: number; expires_at: number } | null {
    const session = this.getSession(ticket, after);
    if (!session) return null;
    session.lastSequence = Math.max(session.lastSequence, after);
    this.touch(session);
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
    this.touch(session);
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  }

  renew(ticket: string): PromptTerminalMetadata | null {
    const decoded = this.decodeTicket(ticket);
    const now = this.now();
    if (!decoded || decoded.renewUntil <= now || (this.revokedUntil.get(decoded.sessionId) ?? 0) > now) return null;
    const currentTicket = this.sessionsById.get(decoded.sessionId);
    let session = currentTicket ? this.sessions.get(currentTicket) : undefined;
    if (session && session.ticket !== ticket) {
      if (decoded.generation <= session.generation && session.renewUntil > now) return this.metadata(session);
      return null;
    }
    if (!session && decoded.workbenchSessionId) {
      const workbenchTicket = this.workbenchTickets.get(decoded.workbenchSessionId);
      const workbenchSession = workbenchTicket ? this.sessions.get(workbenchTicket) : undefined;
      if (workbenchSession && workbenchSession.ticket !== ticket && workbenchSession.renewUntil > now) {
        return this.metadata(workbenchSession);
      }
    }
    if (!session) session = this.restoreTicket(ticket, true, 0) ?? undefined;
    if (!session) return null;

    const previousTicket = session.ticket;
    this.sessions.delete(previousTicket);
    this.touch(session);
    session.generation += 1;
    const claims: PromptTicketClaims = {
      sessionId: session.sessionId,
      ...(session.workbenchSessionId ? { workbenchSessionId: session.workbenchSessionId } : {}),
      generation: session.generation,
      expiresAt: session.expiresAt,
      renewUntil: session.renewUntil,
    };
    session.ticket = this.codec.seal("prompt", claims);
    this.sessions.set(session.ticket, session);
    this.sessionsById.set(session.sessionId, session.ticket);
    // Remap via stored identity sets instead of scanning all maps O(1) vs O(n).
    if (session.workbenchSessionId) {
      this.workbenchTickets.set(session.workbenchSessionId, session.ticket);
    }
    for (const browserSessionId of session.browserSessionIds) {
      this.browserSessionTickets.set(browserSessionId, session.ticket);
    }
    for (const targetKey of session.liveTargetKeys) {
      this.liveTargetTickets.set(targetKey, session.ticket);
    }
    return this.metadata(session);
  }

  sessionIdentity(ticket: string): string | null {
    const session = this.getSession(ticket);
    return session?.workbenchSessionId ?? session?.sessionId ?? null;
  }

  legacyRetirementMetadata(): Omit<PromptTerminalMetadata, "browserFrameUrl" | "browserInputUrl"> {
    return {
      ticket: "legacy-retired",
      expiresAt: 0,
      streamUrl: this.streamUrl,
      snapshotUrl: this.snapshotUrl,
      renewUrl: this.renewUrl,
      streamingEnabled: false,
    };
  }

  revoke(ticket: string): void {
    const decoded = this.decodeTicket(ticket);
    if (decoded) this.revokedUntil.set(decoded.sessionId, decoded.renewUntil);
    this.remove(ticket);
  }

  private metadata(session: PromptSession): PromptTerminalMetadata {
    return {
      ticket: session.ticket,
      expiresAt: session.expiresAt,
      streamUrl: this.streamUrl,
      snapshotUrl: this.snapshotUrl,
      renewUrl: this.renewUrl,
      browserFrameUrl: this.browserFrameUrl,
      browserInputUrl: this.browserInputUrl,
      streamingEnabled: this.streamingEnabledValue,
    };
  }

  private touch(session: PromptSession): void {
    session.expiresAt = this.now() + this.ttlMs;
    session.renewUntil = session.expiresAt + this.renewGraceMs;
  }

  private decodeTicket(ticket: string): PromptTicketClaims | null {
    const claims = this.codec.open<Partial<PromptTicketClaims>>(ticket, "prompt");
    if (!claims
      || typeof claims.sessionId !== "string"
      || !claims.sessionId
      || (claims.workbenchSessionId !== undefined && typeof claims.workbenchSessionId !== "string")
      || !Number.isSafeInteger(claims.generation)
      || (claims.generation ?? -1) < 0
      || !Number.isFinite(claims.expiresAt)
      || !Number.isFinite(claims.renewUntil)
      || (claims.renewUntil ?? 0) < (claims.expiresAt ?? 0)
    ) return null;
    return claims as PromptTicketClaims;
  }

  private restoreTicket(ticket: string, allowExpired: boolean, after: number): PromptSession | null {
    const claims = this.decodeTicket(ticket);
    if (!claims) return null;
    const now = this.now();
    if ((this.revokedUntil.get(claims.sessionId) ?? 0) > now) return null;
    if ((allowExpired ? claims.renewUntil : claims.expiresAt) <= now) return null;
    const currentTicket = this.sessionsById.get(claims.sessionId);
    if (currentTicket) return currentTicket === ticket ? this.sessions.get(currentTicket) ?? null : null;
    if (claims.workbenchSessionId) {
      const workbenchTicket = this.workbenchTickets.get(claims.workbenchSessionId);
      if (workbenchTicket && workbenchTicket !== ticket) return null;
    }
    while (this.sessions.size >= this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (typeof oldest !== "string") break;
      this.remove(oldest);
    }
    const session: PromptSession = {
      ...claims,
      ticket,
      lastSequence: Math.max(0, after),
      events: [],
      listeners: new Set(),
      allowDelegate: false,
      allowSecretWrite: false,
      browserSessionIds: new Set(),
      liveTargetKeys: new Set(),
    };
    this.sessions.set(ticket, session);
    this.sessionsById.set(session.sessionId, ticket);
    if (session.workbenchSessionId) this.workbenchTickets.set(session.workbenchSessionId, ticket);
    return session;
  }

  private getSession(ticket: string, after = 0): PromptSession | null {
    const session = this.sessions.get(ticket) ?? this.restoreTicket(ticket, false, after);
    if (!session) return null;
    if (session.expiresAt <= this.now()) {
      if (session.renewUntil <= this.now()) this.remove(ticket);
      return null;
    }
    return session;
  }

  private prune(): void {
    const now = this.now();
    for (const [ticket, session] of this.sessions) {
      if (session.renewUntil <= now) this.remove(ticket);
    }
    for (const [sessionId, until] of this.revokedUntil) {
      if (until <= now) this.revokedUntil.delete(sessionId);
    }
  }

  private remove(ticket: string): void {
    const session = this.sessions.get(ticket);
    if (!session) return;
    session.listeners.clear();
    this.sessions.delete(ticket);
    if (this.sessionsById.get(session.sessionId) === ticket) this.sessionsById.delete(session.sessionId);
    // Direct delete via stored session identity instead of iterating all maps.
    // This turns O(n) scans into O(1) lookups for the common case.
    if (session.workbenchSessionId && this.workbenchTickets.get(session.workbenchSessionId) === ticket) {
      this.workbenchTickets.delete(session.workbenchSessionId);
    }
    for (const browserSessionId of session.browserSessionIds) {
      if (this.browserSessionTickets.get(browserSessionId) === ticket) this.browserSessionTickets.delete(browserSessionId);
    }
    for (const targetKey of session.liveTargetKeys) {
      if (this.liveTargetTickets.get(targetKey) === ticket) this.liveTargetTickets.delete(targetKey);
    }
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
  private readonly viewers = new LiveViewerRegistry();

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

  handleRenew(request: IncomingMessage, response: ServerResponse): void {
    const ticket = bearerValue(request);
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/live/prompt/renew" || request.method !== "POST" || !ticket) {
      this.json(response, 404, { error: "prompt terminal renewal not found" });
      return;
    }
    const renewed = this.store.renew(ticket);
    if (!renewed) {
      if (!ticket.startsWith("v1.")) {
        this.json(response, 200, this.store.legacyRetirementMetadata(), { "x-cptr-stream-state": "legacy-retired" });
        return;
      }
      this.json(response, 401, { error: "prompt terminal ticket is invalid or outside renewal grace" }, { "www-authenticate": "Bearer" });
      return;
    }
    this.json(response, 200, renewed);
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
    const initial = this.store.replay(ticket, after);
    if (!initial) {
      this.json(response, 401, { error: "prompt terminal ticket is invalid or expired" }, { "www-authenticate": "Bearer" });
      return;
    }
    const streamScope = this.store.sessionIdentity(ticket);
    const viewer = liveViewerIdentity(request);
    let wake: (() => void) | null = null;
    let closed = false;
    const close = () => {
      closed = true;
      wake?.();
      wake = null;
      if (!response.writableEnded) response.end();
    };
    const viewerClaim = streamScope ? this.viewers.claim(streamScope, viewer, close) : "accepted";
    if (viewerClaim === "superseded") {
      this.json(response, 409, { error: "prompt terminal viewer was superseded by a newer Workbench" }, { "x-cptr-stream-state": "superseded" });
      return;
    }
    // A newer iOS/ChatGPT mount must be able to replace its stale stream even
    // when that stale stream currently occupies the final concurrency slot.
    // The replaced handler is closed above and releases its slot in finally.
    if (this.activeStreams >= maxConcurrent && viewerClaim !== "replaced") {
      if (streamScope) this.viewers.release(streamScope, viewer);
      this.json(response, 429, { error: "prompt terminal stream capacity reached" });
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
    response.flushHeaders();

    const queue = [...initial.events];
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
      if (streamScope) this.viewers.release(streamScope, viewer);
      response.end();
      return;
    }
    request.once("close", close);
    response.once("close", close);

    const write = async (chunk: string): Promise<boolean> => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes || closed) return false;
      if (response.write(chunk)) return true;
      return await waitForDrain(request, response);
    };

    try {
      // Establish the HTTP/SSE path immediately instead of waiting for the
      // first tool event or the 15s heartbeat. This is especially important in
      // the ChatGPT iOS webview and through edge proxies, where a header-only
      // streaming response can remain visually stuck in CONNECTING.
      if (!(await write(": connected\n\n"))) return;

      let cursor = after;
      while (!closed && Date.now() < deadline) {
        while (queue.length && !closed) {
          const batch = queue.splice(0);
          for (const event of batch) {
            if (closed) break;
            if (event.sequence <= cursor) continue;
            cursor = event.sequence;
            const frame = `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
            if (!(await write(frame))) return;
          }
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
      if (streamScope) this.viewers.release(streamScope, viewer);
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
