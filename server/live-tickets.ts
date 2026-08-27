import { randomBytes } from "node:crypto";

export type LiveTarget =
  | { targetType: "task" | "monitor"; targetId: string }
  | { targetType: "command"; targetId: string; workspaceId: string };

export type WidgetStreamMetadata<T extends LiveTarget = LiveTarget> = T & {
  ticket: string;
  streamUrl: string;
  snapshotUrl: string;
  renewUrl: string;
  expiresAt: number;
};

type TicketClaims = LiveTarget & { expiresAt: number; renewUntil: number };

export class LiveTicketStore {
  private readonly tickets = new Map<string, TicketClaims>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly renewGraceMs: number;
  private readonly streamUrl: string;
  private readonly snapshotUrl: string;
  private readonly renewUrl: string;
  private readonly maxTickets: number;

  constructor(options: {
    now?: () => number;
    ttlMs?: number;
    renewGraceMs?: number;
    streamUrl?: string;
    snapshotUrl?: string;
    renewUrl?: string;
    maxTickets?: number;
  } = {}) {
    this.now = options.now ?? (() => Date.now());
    // A single backend stream is bounded to ten minutes; retain the opaque
    // target-bound ticket beyond that interval so ordinary reconnects do not
    // fail merely because the browser briefly lost connectivity.
    this.ttlMs = Math.max(1_000, options.ttlMs ?? 15 * 60_000);
    this.renewGraceMs = Math.max(0, options.renewGraceMs ?? 0);
    this.streamUrl = options.streamUrl ?? "/live/stream";
    this.snapshotUrl = options.snapshotUrl ?? this.streamUrl.replace(/\/stream(?:\?.*)?$/, "/snapshot");
    this.renewUrl = options.renewUrl ?? this.streamUrl.replace(/\/stream(?:\?.*)?$/, "/renew");
    this.maxTickets = Math.max(1, options.maxTickets ?? 4_096);
  }

  get size(): number {
    this.pruneExpired(this.now());
    return this.tickets.size;
  }

  private pruneExpired(now: number): void {
    for (const [ticket, claims] of this.tickets) {
      if (claims.renewUntil <= now) this.tickets.delete(ticket);
    }
  }

  private evictOldestIfFull(): void {
    while (this.tickets.size >= this.maxTickets) {
      const oldest = this.tickets.keys().next().value;
      if (typeof oldest !== "string") return;
      this.tickets.delete(oldest);
    }
  }

  issue<T extends LiveTarget>(target: T): WidgetStreamMetadata<T> {
    const now = this.now();
    this.pruneExpired(now);
    this.evictOldestIfFull();
    const ticket = randomBytes(32).toString("base64url");
    const expiresAt = now + this.ttlMs;
    const renewUntil = expiresAt + this.renewGraceMs;
    this.tickets.set(ticket, { ...target, expiresAt, renewUntil });
    return {
      ...target,
      ticket,
      expiresAt,
      streamUrl: this.streamUrl,
      snapshotUrl: this.snapshotUrl,
      renewUrl: this.renewUrl,
    };
  }

  validate(ticket: string, target?: LiveTarget): TicketClaims | null {
    const claims = this.tickets.get(ticket);
    const now = this.now();
    if (!claims || claims.expiresAt <= now) {
      if (claims && claims.renewUntil <= now) this.tickets.delete(ticket);
      return null;
    }
    if (target && (claims.targetType !== target.targetType || claims.targetId !== target.targetId)) {
      return null;
    }
    if (
      target?.targetType === "command" &&
      (claims.targetType !== "command" || claims.workspaceId !== target.workspaceId)
    ) {
      return null;
    }
    return { ...claims };
  }

  renew(ticket: string): WidgetStreamMetadata | null {
    const claims = this.tickets.get(ticket);
    const now = this.now();
    if (!claims || claims.renewUntil <= now) {
      if (claims) this.tickets.delete(ticket);
      return null;
    }
    const target: LiveTarget = claims.targetType === "command"
      ? { targetType: "command", targetId: claims.targetId, workspaceId: claims.workspaceId }
      : { targetType: claims.targetType, targetId: claims.targetId };
    this.tickets.delete(ticket);
    return this.issue(target);
  }

  revoke(ticket: string): void {
    this.tickets.delete(ticket);
  }
}
