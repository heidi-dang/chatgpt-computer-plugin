import { randomBytes } from "node:crypto";

export type LiveTarget = { targetType: "task" | "monitor"; targetId: string };

export type WidgetStreamMetadata = LiveTarget & {
  ticket: string;
  streamUrl: string;
  snapshotUrl: string;
  expiresAt: number;
};

type TicketClaims = LiveTarget & { expiresAt: number };

export class LiveTicketStore {
  private readonly tickets = new Map<string, TicketClaims>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly streamUrl: string;
  private readonly snapshotUrl: string;
  private readonly maxTickets: number;

  constructor(options: { now?: () => number; ttlMs?: number; streamUrl?: string; snapshotUrl?: string; maxTickets?: number } = {}) {
    this.now = options.now ?? (() => Date.now());
    // A single backend stream is bounded to ten minutes; retain the opaque
    // target-bound ticket beyond that interval so ordinary reconnects do not
    // fail merely because the browser briefly lost connectivity.
    this.ttlMs = Math.max(1_000, options.ttlMs ?? 15 * 60_000);
    this.streamUrl = options.streamUrl ?? "/live/stream";
    this.snapshotUrl = options.snapshotUrl ?? this.streamUrl.replace(/\/stream(?:\?.*)?$/, "/snapshot");
    this.maxTickets = Math.max(1, options.maxTickets ?? 4_096);
  }

  get size(): number {
    this.pruneExpired(this.now());
    return this.tickets.size;
  }

  private pruneExpired(now: number): void {
    for (const [ticket, claims] of this.tickets) {
      if (claims.expiresAt <= now) this.tickets.delete(ticket);
    }
  }

  private evictOldestIfFull(): void {
    while (this.tickets.size >= this.maxTickets) {
      const oldest = this.tickets.keys().next().value;
      if (typeof oldest !== "string") return;
      this.tickets.delete(oldest);
    }
  }

  issue(target: LiveTarget): WidgetStreamMetadata {
    const now = this.now();
    this.pruneExpired(now);
    this.evictOldestIfFull();
    const ticket = randomBytes(32).toString("base64url");
    const expiresAt = now + this.ttlMs;
    this.tickets.set(ticket, { ...target, expiresAt });
    return { ...target, ticket, expiresAt, streamUrl: this.streamUrl, snapshotUrl: this.snapshotUrl };
  }

  validate(ticket: string, target?: LiveTarget): TicketClaims | null {
    const claims = this.tickets.get(ticket);
    if (!claims || claims.expiresAt <= this.now()) {
      if (claims) this.tickets.delete(ticket);
      return null;
    }
    if (target && (claims.targetType !== target.targetType || claims.targetId !== target.targetId)) {
      return null;
    }
    return { ...claims };
  }

  revoke(ticket: string): void {
    this.tickets.delete(ticket);
  }
}
