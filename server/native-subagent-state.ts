import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_TTL_MS = 30 * 60_000;
const MAX_STATE_BYTES = 2_000_000;
const CLAIM_TTL_MS = 60_000;

export type NativeSubagentStatus =
  | "pending"
  | "complete"
  | "incomplete"
  | "client_sampling_failed"
  | "limit_exceeded"
  | "cancelled";

export type StoredSamplingMessage = {
  role: "user" | "assistant";
  content: unknown;
};

export type NativeSubagentBranch = {
  key: string;
  index: number;
  taskId: string;
  workspaceId: string | null;
  workerId: string | null;
  objective: string;
  status: NativeSubagentStatus;
  rounds: number;
  toolCalls: number;
  messages: StoredSamplingMessage[];
  output: string;
  error: string;
  model: string | null;
};

export type NativeSubagentState = {
  id: string;
  version: number;
  status: "initializing" | "running" | "terminal";
  parentTaskId: string;
  fingerprint: string;
  idempotencyKey: string | null;
  objectives: string[];
  maxTokens: number;
  requestedModel: string | null;
  coding: boolean;
  workspaceId: string | null;
  repoPath: string | null;
  task: unknown;
  dispatch: Record<string, unknown> | null;
  branches: NativeSubagentBranch[];
  processingUntil: number | null;
  cleanup: { attempted: number; released: number; failed: number } | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
};

export type NewNativeSubagentState = Omit<
  NativeSubagentState,
  "id" | "version" | "createdAt" | "updatedAt" | "expiresAt"
>;

type StoredRow = {
  state_json?: unknown;
  version?: unknown;
  processing_until?: unknown;
};

export class NativeSubagentStateStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(path: string, options: { now?: () => number; ttlMs?: number } = {}) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=FULL");
    this.db.exec("PRAGMA busy_timeout=5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS native_subagent_fanouts (
        id TEXT PRIMARY KEY,
        parent_task_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        idempotency_key TEXT,
        status TEXT NOT NULL,
        state_json TEXT NOT NULL,
        version INTEGER NOT NULL,
        processing_until INTEGER,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS native_subagent_fanouts_pending
        ON native_subagent_fanouts(parent_task_id, fingerprint, status, expires_at);
      CREATE UNIQUE INDEX IF NOT EXISTS native_subagent_fanouts_idempotency
        ON native_subagent_fanouts(parent_task_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    `);
    this.now = options.now ?? Date.now;
    this.ttlMs = Math.max(60_000, options.ttlMs ?? DEFAULT_TTL_MS);
  }

  close(): void {
    this.db.close();
  }

  private prune(now = this.now()): void {
    this.db.prepare("DELETE FROM native_subagent_fanouts WHERE expires_at <= ?").run(now);
  }

  private parse(row: StoredRow | undefined): NativeSubagentState | null {
    if (!row || typeof row.state_json !== "string") return null;
    try {
      const state = JSON.parse(row.state_json) as NativeSubagentState;
      state.version = Number(row.version ?? state.version ?? 0);
      state.processingUntil =
        row.processing_until == null ? null : Number(row.processing_until);
      return state;
    } catch {
      return null;
    }
  }

  get(id: string): NativeSubagentState | null {
    const now = this.now();
    this.prune(now);
    return this.parse(this.db.prepare(`
      SELECT state_json, version, processing_until
      FROM native_subagent_fanouts
      WHERE id = ? AND expires_at > ?
    `).get(id, now) as StoredRow | undefined);
  }

  begin(input: NewNativeSubagentState): {
    state: NativeSubagentState;
    created: boolean;
  } {
    const now = this.now();
    this.prune(now);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = input.idempotencyKey
        ? this.db.prepare(`
            SELECT state_json, version, processing_until
            FROM native_subagent_fanouts
            WHERE parent_task_id = ? AND idempotency_key = ? AND expires_at > ?
          `).get(input.parentTaskId, input.idempotencyKey, now)
        : this.db.prepare(`
            SELECT state_json, version, processing_until
            FROM native_subagent_fanouts
            WHERE parent_task_id = ? AND fingerprint = ?
              AND status != 'terminal' AND expires_at > ?
            ORDER BY created_at DESC
            LIMIT 1
          `).get(input.parentTaskId, input.fingerprint, now);
      const recovered = this.parse(existing as StoredRow | undefined);
      if (recovered) {
        this.db.exec("COMMIT");
        return { state: recovered, created: false };
      }

      const state: NativeSubagentState = {
        ...input,
        id: `fanout_${randomUUID().replaceAll("-", "")}`,
        version: 1,
        createdAt: now,
        updatedAt: now,
        expiresAt: now + this.ttlMs,
      };
      const serialized = JSON.stringify(state);
      if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES) {
        throw new Error("native subagent state exceeds the bounded state size");
      }
      this.db.prepare(`
        INSERT INTO native_subagent_fanouts(
          id, parent_task_id, fingerprint, idempotency_key, status, state_json,
          version, processing_until, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        state.id,
        state.parentTaskId,
        state.fingerprint,
        state.idempotencyKey,
        state.status,
        serialized,
        state.version,
        state.processingUntil,
        state.expiresAt,
        state.createdAt,
        state.updatedAt,
      );
      this.db.exec("COMMIT");
      return { state, created: true };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // best effort
      }
      throw error;
    }
  }

  save(
    state: NativeSubagentState,
    expectedVersion: number,
  ): NativeSubagentState | null {
    const now = this.now();
    const next: NativeSubagentState = {
      ...state,
      version: expectedVersion + 1,
      updatedAt: now,
      expiresAt: Math.max(state.expiresAt, now + this.ttlMs),
    };
    const serialized = JSON.stringify(next);
    if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES) {
      throw new Error("native subagent state exceeds the bounded state size");
    }
    const changed = this.db.prepare(`
      UPDATE native_subagent_fanouts
      SET status = ?, state_json = ?, version = ?, processing_until = ?,
          expires_at = ?, updated_at = ?
      WHERE id = ? AND version = ?
    `).run(
      next.status,
      serialized,
      next.version,
      next.processingUntil,
      next.expiresAt,
      next.updatedAt,
      next.id,
      expectedVersion,
    );
    return Number(changed.changes) === 1 ? next : null;
  }

  claim(id: string, expectedVersion: number): NativeSubagentState | null {
    const current = this.get(id);
    if (!current || current.version !== expectedVersion) return null;
    const now = this.now();
    if ((current.processingUntil ?? 0) > now) return null;
    return this.save(
      { ...current, processingUntil: now + CLAIM_TTL_MS },
      expectedVersion,
    );
  }
}
