import { randomBytes } from "node:crypto";
import { LiveTicketCodec } from "./live-ticket-codec.js";
import { LiveTicketStateStore } from "./live-ticket-state.js";

export type LiveTarget =
  | { targetType: "task" | "monitor"; targetId: string }
  | { targetType: "command"; targetId: string; workspaceId: string; workerId?: string };

export type WidgetStreamMetadata<T extends LiveTarget = LiveTarget> = T & {
  ticket: string;
  streamUrl: string;
  snapshotUrl: string;
  renewUrl: string;
  expiresAt: number;
};

type TicketClaims = LiveTarget & {
  sessionId: string;
  generation: number;
  expiresAt: number;
  renewUntil: number;
};

type TicketSession = TicketClaims & { ticket: string };

type RawTicketClaims = {
  targetType?: unknown;
  targetId?: unknown;
  workspaceId?: unknown;
  workerId?: unknown;
  sessionId?: unknown;
  generation?: unknown;
  expiresAt?: unknown;
  renewUntil?: unknown;
};

function parseClaims(value: unknown): TicketClaims | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as RawTicketClaims;
  if (typeof raw.sessionId !== "string" || !raw.sessionId) return null;
  if (typeof raw.generation !== "number" || !Number.isSafeInteger(raw.generation) || raw.generation < 0) return null;
  if (typeof raw.expiresAt !== "number" || !Number.isFinite(raw.expiresAt)) return null;
  if (typeof raw.renewUntil !== "number" || !Number.isFinite(raw.renewUntil) || raw.renewUntil < raw.expiresAt) return null;
  if (typeof raw.targetId !== "string" || !raw.targetId) return null;
  const common = {
    sessionId: raw.sessionId,
    generation: raw.generation,
    expiresAt: raw.expiresAt,
    renewUntil: raw.renewUntil,
  };
  if (raw.targetType === "task" || raw.targetType === "monitor") {
    return { targetType: raw.targetType, targetId: raw.targetId, ...common };
  }
  if (raw.targetType !== "command" || typeof raw.workspaceId !== "string" || !raw.workspaceId) return null;
  if (raw.workerId !== undefined && typeof raw.workerId !== "string") return null;
  return {
    targetType: "command",
    targetId: raw.targetId,
    workspaceId: raw.workspaceId,
    ...(raw.workerId ? { workerId: raw.workerId } : {}),
    ...common,
  };
}

export class LiveTicketStore {
  private readonly sessions = new Map<string, TicketSession>();
  private readonly ticketIndex = new Map<string, string>();
  private readonly revokedUntil = new Map<string, number>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly renewGraceMs: number;
  private readonly streamUrl: string;
  private readonly snapshotUrl: string;
  private readonly renewUrl: string;
  private readonly maxTickets: number;
  private readonly codec: LiveTicketCodec;
  private readonly durableState: LiveTicketStateStore | null;

  constructor(options: {
    now?: () => number;
    ttlMs?: number;
    renewGraceMs?: number;
    streamUrl?: string;
    snapshotUrl?: string;
    renewUrl?: string;
    maxTickets?: number;
    ticketSecret?: string | Buffer;
    stateDbPath?: string;
  } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = Math.max(1_000, options.ttlMs ?? 15 * 60_000);
    this.renewGraceMs = Math.max(
      0,
      options.renewGraceMs ?? (options.ttlMs === undefined ? this.ttlMs : 0),
    );
    this.streamUrl = options.streamUrl ?? "/live/stream";
    this.snapshotUrl = options.snapshotUrl ?? this.streamUrl.replace(/\/stream(?:\?.*)?$/, "/snapshot");
    this.renewUrl = options.renewUrl ?? this.streamUrl.replace(/\/stream(?:\?.*)?$/, "/renew");
    this.maxTickets = Math.max(1, options.maxTickets ?? 4_096);
    this.codec = new LiveTicketCodec(options.ticketSecret);
    this.durableState = options.stateDbPath ? new LiveTicketStateStore(options.stateDbPath) : null;
  }

  get size(): number {
    this.pruneExpired(this.now());
    return this.sessions.size;
  }

  close(): void {
    this.durableState?.close();
  }

  private isDurablyCurrent(session: TicketSession, ticket: string, now: number): boolean {
    return this.durableState?.isCurrent(
      session.sessionId,
      ticket,
      session.generation,
      now,
      true,
    ) ?? true;
  }

  private pruneExpired(now: number): void {
    for (const [sessionId, session] of this.sessions) {
      if (session.renewUntil <= now) {
        this.sessions.delete(sessionId);
        this.ticketIndex.delete(session.ticket);
      }
    }
    for (const [sessionId, until] of this.revokedUntil) {
      if (until <= now) this.revokedUntil.delete(sessionId);
    }
  }

  private evictOldestIfFull(): void {
    while (this.sessions.size >= this.maxTickets) {
      const oldest = this.sessions.keys().next().value;
      if (typeof oldest !== "string") return;
      const evicted = this.sessions.get(oldest);
      this.sessions.delete(oldest);
      if (evicted) this.ticketIndex.delete(evicted.ticket);
    }
  }

  private metadata(session: TicketSession): WidgetStreamMetadata {
    const target = session.targetType === "command"
      ? {
          targetType: "command" as const,
          targetId: session.targetId,
          workspaceId: session.workspaceId,
          ...(session.workerId ? { workerId: session.workerId } : {}),
        }
      : { targetType: session.targetType, targetId: session.targetId };
    return {
      ...target,
      ticket: session.ticket,
      expiresAt: session.expiresAt,
      streamUrl: this.streamUrl,
      snapshotUrl: this.snapshotUrl,
      renewUrl: this.renewUrl,
    };
  }

  private restore(ticket: string, allowExpired: boolean): TicketSession | null {
    const decoded = parseClaims(this.codec.open<unknown>(ticket, "live"));
    if (!decoded) return null;
    const now = this.now();
    if ((this.revokedUntil.get(decoded.sessionId) ?? 0) > now) return null;
    if (this.durableState && !this.durableState.isCurrent(decoded.sessionId, ticket, decoded.generation, now, true)) return null;
    if ((allowExpired ? decoded.renewUntil : decoded.expiresAt) <= now) return null;
    const current = this.sessions.get(decoded.sessionId);
    if (current) {
      if (current.ticket === ticket && current.generation === decoded.generation) return current;
      // A replica may still cache the previous generation after another process
      // atomically renewed the session. Durable state already proved this exact
      // ticket/generation is authoritative, so replace only that stale local cache.
      if (!this.durableState) return null;
      this.sessions.delete(decoded.sessionId);
    }
    this.evictOldestIfFull();
    const restored: TicketSession = { ...decoded, ticket };
    this.sessions.set(decoded.sessionId, restored);
    this.ticketIndex.set(ticket, decoded.sessionId);
    return restored;
  }

  issue<T extends LiveTarget>(target: T): WidgetStreamMetadata<T> {
    const now = this.now();
    this.pruneExpired(now);
    this.evictOldestIfFull();
    const claims: TicketClaims = {
      ...target,
      sessionId: randomBytes(18).toString("base64url"),
      generation: 0,
      expiresAt: now + this.ttlMs,
      renewUntil: now + this.ttlMs + this.renewGraceMs,
    };
    const ticket = this.codec.seal("live", claims);
    const session: TicketSession = { ...claims, ticket };
    this.durableState?.remember(claims.sessionId, ticket, claims.generation, claims.renewUntil, now);
    this.sessions.set(claims.sessionId, session);
    this.ticketIndex.set(ticket, claims.sessionId);
    return this.metadata(session) as unknown as WidgetStreamMetadata<T>;
  }

  validate(ticket: string, target?: LiveTarget): TicketClaims | null {
    const indexedId = this.ticketIndex.get(ticket);
    let session = (indexedId ? this.sessions.get(indexedId) : undefined) ?? this.restore(ticket, false);
    const now = this.now();
    if (session && !this.isDurablyCurrent(session, ticket, now)) {
      this.sessions.delete(session.sessionId);
      this.ticketIndex.delete(ticket);
      session = null;
    }
    if (!session || session.expiresAt <= now) return null;
    if (target && (session.targetType !== target.targetType || session.targetId !== target.targetId)) return null;
    if (
      target?.targetType === "command" &&
      (
        session.targetType !== "command"
        || session.workspaceId !== target.workspaceId
        || session.workerId !== target.workerId
      )
    ) return null;
    const { ticket: _ticket, ...claims } = session;
    return { ...claims };
  }

  sessionIdentity(ticket: string): string | null {
    const indexedId = this.ticketIndex.get(ticket);
    const session = (indexedId ? this.sessions.get(indexedId) : undefined) ?? this.restore(ticket, false);
    if (!session || !this.isDurablyCurrent(session, ticket, this.now())) return null;
    return session.sessionId;
  }

  renew(ticket: string): WidgetStreamMetadata | null {
    const decoded = parseClaims(this.codec.open<unknown>(ticket, "live"));
    const now = this.now();
    if (!decoded || decoded.renewUntil <= now || (this.revokedUntil.get(decoded.sessionId) ?? 0) > now) return null;
    let session = this.sessions.get(decoded.sessionId);
    if (session && session.ticket !== ticket) {
      if (
        decoded.generation <= session.generation
        && session.renewUntil > now
        && this.isDurablyCurrent(session, session.ticket, now)
      ) return this.metadata(session);
      return null;
    }
    if (!session) session = this.restore(ticket, true) ?? undefined;
    if (!session) return null;

    const nextClaims: TicketClaims = {
      ...(session.targetType === "command"
        ? {
            targetType: "command" as const,
            targetId: session.targetId,
            workspaceId: session.workspaceId,
            ...(session.workerId ? { workerId: session.workerId } : {}),
          }
        : { targetType: session.targetType, targetId: session.targetId }),
      sessionId: session.sessionId,
      generation: session.generation + 1,
      expiresAt: now + this.ttlMs,
      renewUntil: now + this.ttlMs + this.renewGraceMs,
    };
    const nextTicket = this.codec.seal("live", nextClaims);
    if (
      this.durableState
      && !this.durableState.advance(
        session.sessionId,
        ticket,
        session.generation,
        nextTicket,
        nextClaims.generation,
        nextClaims.renewUntil,
        now,
      )
    ) return null;
    const next: TicketSession = { ...nextClaims, ticket: nextTicket };
    this.ticketIndex.delete(ticket);
    this.sessions.set(next.sessionId, next);
    this.ticketIndex.set(nextTicket, next.sessionId);
    return this.metadata(next);
  }

  revoke(ticket: string): void {
    const decoded = parseClaims(this.codec.open<unknown>(ticket, "live"));
    if (!decoded) return;
    const now = this.now();
    this.revokedUntil.set(decoded.sessionId, decoded.renewUntil);
    this.durableState?.revoke(decoded.sessionId, decoded.renewUntil, now);
    const existing = this.sessions.get(decoded.sessionId);
    if (existing) this.ticketIndex.delete(existing.ticket);
    this.sessions.delete(decoded.sessionId);
  }
}
