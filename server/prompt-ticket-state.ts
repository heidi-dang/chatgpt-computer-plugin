import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type PromptTicketDurableState = {
  sessionId: string;
  ticketHash: string;
  generation: number;
  expiresAt: number;
  renewUntil: number;
  revokedUntil: number | null;
};

function ticketHash(ticket: string): string {
  return createHash("sha256").update(ticket, "utf8").digest("hex");
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export class PromptTicketStateStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=FULL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS prompt_ticket_sessions (
        session_id TEXT PRIMARY KEY,
        ticket_hash TEXT NOT NULL,
        generation INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        renew_until INTEGER NOT NULL,
        revoked_until INTEGER,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS prompt_ticket_sessions_expiry
        ON prompt_ticket_sessions(renew_until);
    `);
  }

  close(): void {
    this.db.close();
  }

  prune(now: number): void {
    this.db.prepare("DELETE FROM prompt_ticket_sessions WHERE renew_until <= ?").run(now);
  }

  get(sessionId: string, now: number): PromptTicketDurableState | null {
    this.prune(now);
    const row = this.db.prepare(`
      SELECT session_id, ticket_hash, generation, expires_at, renew_until, revoked_until
      FROM prompt_ticket_sessions
      WHERE session_id = ?
    `).get(sessionId) as {
      session_id?: unknown;
      ticket_hash?: unknown;
      generation?: unknown;
      expires_at?: unknown;
      renew_until?: unknown;
      revoked_until?: unknown;
    } | undefined;
    if (!row) return null;
    const generation = Number(row.generation);
    const expiresAt = Number(row.expires_at);
    const renewUntil = Number(row.renew_until);
    if (!Number.isSafeInteger(generation) || !Number.isFinite(expiresAt) || !Number.isFinite(renewUntil)) return null;
    return {
      sessionId: String(row.session_id ?? sessionId),
      ticketHash: String(row.ticket_hash ?? ""),
      generation,
      expiresAt,
      renewUntil,
      revokedUntil: numberOrNull(row.revoked_until),
    };
  }

  current(
    sessionId: string,
    ticket: string,
    generation: number,
    now: number,
    allowExpired = false,
  ): PromptTicketDurableState | null {
    const state = this.get(sessionId, now);
    if (!state) return null;
    if ((state.revokedUntil ?? 0) > now) return null;
    if (state.generation !== generation || state.ticketHash !== ticketHash(ticket)) return null;
    if ((allowExpired ? state.renewUntil : state.expiresAt) <= now) return null;
    return state;
  }

  remember(
    sessionId: string,
    ticket: string,
    generation: number,
    expiresAt: number,
    renewUntil: number,
    now: number,
  ): void {
    this.prune(now);
    this.db.prepare(`
      INSERT INTO prompt_ticket_sessions(
        session_id, ticket_hash, generation, expires_at, renew_until, revoked_until, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        ticket_hash = excluded.ticket_hash,
        generation = excluded.generation,
        expires_at = excluded.expires_at,
        renew_until = excluded.renew_until,
        revoked_until = NULL,
        updated_at = excluded.updated_at
    `).run(sessionId, ticketHash(ticket), generation, expiresAt, renewUntil, now);
  }

  refresh(
    sessionId: string,
    ticket: string,
    generation: number,
    nextExpiresAt: number,
    nextRenewUntil: number,
    now: number,
  ): { expiresAt: number; renewUntil: number } | null {
    this.prune(now);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`
        SELECT ticket_hash, generation, expires_at, renew_until, revoked_until
        FROM prompt_ticket_sessions
        WHERE session_id = ?
      `).get(sessionId) as {
        ticket_hash?: unknown;
        generation?: unknown;
        expires_at?: unknown;
        renew_until?: unknown;
        revoked_until?: unknown;
      } | undefined;
      const revokedUntil = numberOrNull(row?.revoked_until);
      const valid = Boolean(
        row
        && String(row.ticket_hash ?? "") === ticketHash(ticket)
        && Number(row.generation) === generation
        && Number(row.renew_until) > now
        && (revokedUntil ?? 0) <= now,
      );
      if (!valid) {
        this.db.exec("ROLLBACK");
        return null;
      }
      const expiresAt = Math.max(Number(row?.expires_at), nextExpiresAt);
      const renewUntil = Math.max(Number(row?.renew_until), nextRenewUntil);
      this.db.prepare(`
        UPDATE prompt_ticket_sessions
        SET expires_at = ?, renew_until = ?, updated_at = ?
        WHERE session_id = ?
      `).run(expiresAt, renewUntil, now, sessionId);
      this.db.exec("COMMIT");
      return { expiresAt, renewUntil };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* best effort */ }
      throw error;
    }
  }

  advance(
    sessionId: string,
    currentTicket: string,
    currentGeneration: number,
    nextTicket: string,
    nextGeneration: number,
    nextExpiresAt: number,
    nextRenewUntil: number,
    now: number,
  ): boolean {
    this.prune(now);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`
        SELECT ticket_hash, generation, expires_at, renew_until, revoked_until
        FROM prompt_ticket_sessions
        WHERE session_id = ?
      `).get(sessionId) as {
        ticket_hash?: unknown;
        generation?: unknown;
        expires_at?: unknown;
        renew_until?: unknown;
        revoked_until?: unknown;
      } | undefined;
      const revokedUntil = numberOrNull(row?.revoked_until);
      const valid = Boolean(
        row
        && String(row.ticket_hash ?? "") === ticketHash(currentTicket)
        && Number(row.generation) === currentGeneration
        && Number(row.renew_until) > now
        && (revokedUntil ?? 0) <= now,
      );
      if (!valid) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db.prepare(`
        UPDATE prompt_ticket_sessions
        SET ticket_hash = ?, generation = ?,
            expires_at = MAX(expires_at, ?), renew_until = MAX(renew_until, ?),
            revoked_until = NULL, updated_at = ?
        WHERE session_id = ?
      `).run(
        ticketHash(nextTicket),
        nextGeneration,
        nextExpiresAt,
        nextRenewUntil,
        now,
        sessionId,
      );
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* best effort */ }
      throw error;
    }
  }

  revoke(sessionId: string, renewUntil: number, now: number): void {
    const until = Math.max(now + 1, renewUntil);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT INTO prompt_ticket_sessions(
          session_id, ticket_hash, generation, expires_at, renew_until, revoked_until, updated_at
        ) VALUES (?, '', -1, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          expires_at = MAX(prompt_ticket_sessions.expires_at, excluded.expires_at),
          renew_until = MAX(prompt_ticket_sessions.renew_until, excluded.renew_until),
          revoked_until = MAX(COALESCE(prompt_ticket_sessions.revoked_until, 0), excluded.revoked_until),
          updated_at = excluded.updated_at
      `).run(sessionId, until, until, until, now);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* best effort */ }
      throw error;
    }
  }
}
