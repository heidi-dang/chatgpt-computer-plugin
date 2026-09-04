import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type AuthorizationCodeRecord = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
  subject: string;
  email: string | null;
};

export type RefreshTokenRecord = {
  clientId: string;
  resource: string;
  scope: string;
  subject: string;
  email: string | null;
  familyId: string;
  expiresAt: number;
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function opaqueToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function parseJsonRecord<T>(value: unknown): T | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as T;
    return parsed ?? null;
  } catch {
    return null;
  }
}

export class OAuthStateStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=FULL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
        code_hash TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS oauth_authorization_codes_expiry
        ON oauth_authorization_codes(expires_at);
      CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
        token_hash TEXT PRIMARY KEY,
        family_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        used_at INTEGER,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_expiry
        ON oauth_refresh_tokens(expires_at);
      CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_family
        ON oauth_refresh_tokens(family_id);
    `);
  }

  close(): void {
    this.db.close();
  }

  prune(now = Date.now()): void {
    this.db.prepare("DELETE FROM oauth_authorization_codes WHERE expires_at <= ?").run(now);
    this.db.prepare("DELETE FROM oauth_refresh_tokens WHERE expires_at <= ?").run(now);
  }

  issueAuthorizationCode(record: AuthorizationCodeRecord, ttlMs: number, now = Date.now()): string {
    this.prune(now);
    const code = opaqueToken("cptr_code");
    this.db.prepare(`
      INSERT INTO oauth_authorization_codes(code_hash, payload_json, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `).run(sha256(code), JSON.stringify(record), now + ttlMs, now);
    return code;
  }

  consumeAuthorizationCode(code: string, now = Date.now()): AuthorizationCodeRecord | null {
    this.prune(now);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`
        SELECT payload_json, expires_at
        FROM oauth_authorization_codes
        WHERE code_hash = ?
      `).get(sha256(code)) as { payload_json?: unknown; expires_at?: unknown } | undefined;
      if (!row || Number(row.expires_at) <= now) {
        this.db.exec("ROLLBACK");
        return null;
      }
      this.db.prepare("DELETE FROM oauth_authorization_codes WHERE code_hash = ?").run(sha256(code));
      this.db.exec("COMMIT");
      return parseJsonRecord<AuthorizationCodeRecord>(row.payload_json);
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* best effort */ }
      throw error;
    }
  }

  issueRefreshToken(
    input: Omit<RefreshTokenRecord, "familyId" | "expiresAt"> & { familyId?: string },
    expiresAt: number,
    now = Date.now(),
  ): { token: string; record: RefreshTokenRecord } {
    this.prune(now);
    const token = opaqueToken("cptr_refresh");
    const record: RefreshTokenRecord = {
      ...input,
      familyId: input.familyId ?? randomUUID(),
      expiresAt,
    };
    this.db.prepare(`
      INSERT INTO oauth_refresh_tokens(token_hash, family_id, payload_json, expires_at, created_at, used_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, NULL, NULL)
    `).run(sha256(token), record.familyId, JSON.stringify(record), expiresAt, now);
    return { token, record };
  }

  rotateRefreshToken(
    token: string,
    expected: { clientId: string; resource: string },
    now = Date.now(),
  ): { token: string; record: RefreshTokenRecord } | null {
    this.prune(now);
    const tokenHash = sha256(token);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`
        SELECT family_id, payload_json, expires_at, used_at, revoked_at
        FROM oauth_refresh_tokens
        WHERE token_hash = ?
      `).get(tokenHash) as {
        family_id?: unknown;
        payload_json?: unknown;
        expires_at?: unknown;
        used_at?: unknown;
        revoked_at?: unknown;
      } | undefined;
      if (!row || Number(row.expires_at) <= now || row.revoked_at !== null && row.revoked_at !== undefined) {
        this.db.exec("ROLLBACK");
        return null;
      }
      const familyId = String(row.family_id ?? "");
      if (row.used_at !== null && row.used_at !== undefined) {
        this.db.prepare("UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL")
          .run(now, familyId);
        this.db.exec("COMMIT");
        return null;
      }
      const record = parseJsonRecord<RefreshTokenRecord>(row.payload_json);
      if (!record || record.clientId !== expected.clientId || record.resource !== expected.resource) {
        this.db.exec("ROLLBACK");
        return null;
      }
      this.db.prepare("UPDATE oauth_refresh_tokens SET used_at = ? WHERE token_hash = ?").run(now, tokenHash);
      const replacement = opaqueToken("cptr_refresh");
      this.db.prepare(`
        INSERT INTO oauth_refresh_tokens(token_hash, family_id, payload_json, expires_at, created_at, used_at, revoked_at)
        VALUES (?, ?, ?, ?, ?, NULL, NULL)
      `).run(sha256(replacement), record.familyId, JSON.stringify(record), record.expiresAt, now);
      this.db.exec("COMMIT");
      return { token: replacement, record };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* best effort */ }
      throw error;
    }
  }

  revokeRefreshToken(token: string, now = Date.now()): void {
    const row = this.db.prepare("SELECT family_id FROM oauth_refresh_tokens WHERE token_hash = ?")
      .get(sha256(token)) as { family_id?: unknown } | undefined;
    if (!row?.family_id) return;
    this.db.prepare("UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL")
      .run(now, String(row.family_id));
  }
}
