import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { jwtVerify, SignJWT } from "jose";
import {
  issueDynamicClientId,
  pkceS256,
  resolveOAuthClient,
  validateRedirectUri,
  type DynamicClientRegistrationInput,
} from "./oauth-client-metadata.js";
import { OAuthStateStore, type AuthorizationCodeRecord, type RefreshTokenRecord } from "./oauth-state.js";

const JSON_LIMIT = 64 * 1024;
const FORM_LIMIT = 64 * 1024;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

export type NativeOAuthIdentity = {
  subject: string;
  email: string | null;
};

export type NativeOAuthServerConfig = {
  issuer: string;
  resource: string;
  scopes: readonly string[];
  secret: string;
  stateDbPath: string;
  accessTokenTtlMs?: number;
  grantTtlMs?: number;
  authorizationCodeTtlMs?: number;
};

type AuthorizationTicket = {
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
  state: string | null;
};

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    pragma: "no-cache",
    ...headers,
  }).end(JSON.stringify(body));
}

function oauthError(res: ServerResponse, status: number, error: string, description: string): void {
  json(res, status, { error, error_description: description });
}

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.byteLength;
    if (size > limit) throw new Error("request body too large");
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req, JSON_LIMIT);
  const parsed = JSON.parse(raw || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON object required");
  return parsed as Record<string, unknown>;
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const contentType = String(req.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") throw new Error("application/x-www-form-urlencoded required");
  return new URLSearchParams(await readBody(req, FORM_LIMIT));
}

function requestedScope(value: string | null, supported: readonly string[]): string {
  const requested = (value ?? "").split(/\s+/).map((scope) => scope.trim()).filter(Boolean);
  const selected = requested.length ? requested : [...supported];
  const supportedSet = new Set(supported);
  if (selected.some((scope) => !supportedSet.has(scope))) throw new Error("requested scope is not supported");
  return [...new Set(selected)].join(" ");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

function appendRedirectParams(redirectUri: string, params: Record<string, string | null>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) if (value !== null) url.searchParams.set(key, value);
  return url.href;
}

function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

function consentHtml(ticket: string, details: AuthorizationTicket): string {
  const redirect = new URL(details.redirectUri);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize CPTR Computer</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 20px;color:#171717}main{border:1px solid #ddd;border-radius:14px;padding:24px}h1{font-size:22px;margin:0 0 14px}dl{display:grid;grid-template-columns:120px 1fr;gap:8px 12px}dt{font-weight:600}dd{margin:0;overflow-wrap:anywhere}.actions{display:flex;gap:10px;margin-top:22px}button{padding:10px 16px;border-radius:8px;border:1px solid #bbb;background:white;font-weight:600}button[value=approve]{background:#111;color:white;border-color:#111}.warning{margin-top:16px;padding:10px 12px;background:#fff7e6;border-radius:8px}</style></head>
<body><main><h1>Authorize CPTR Computer</h1><p>An MCP client is requesting access to your CPTR Computer server.</p>
<dl><dt>Client</dt><dd>${htmlEscape(details.clientName)}</dd><dt>Resource</dt><dd>${htmlEscape(details.resource)}</dd><dt>Scopes</dt><dd>${htmlEscape(details.scope || "default")}</dd><dt>Redirect</dt><dd>${htmlEscape(redirect.host)}</dd></dl>
${["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname) ? '<div class="warning">This client redirects to a loopback address on this device. Approve only if you initiated the connection.</div>' : ""}
<form method="post" action="/oauth/login"><input type="hidden" name="ticket" value="${htmlEscape(ticket)}"><div class="actions"><button type="submit" name="decision" value="approve">Approve</button><button type="submit" name="decision" value="deny">Deny</button></div></form>
</main></body></html>`;
}

export class NativeOAuthServer {
  readonly issuer: string;
  readonly resource: string;
  readonly scopes: readonly string[];
  private readonly secret: string;
  private readonly state: OAuthStateStore;
  private readonly accessTokenTtlMs: number;
  private readonly grantTtlMs: number;
  private readonly authorizationCodeTtlMs: number;

  constructor(config: NativeOAuthServerConfig) {
    this.issuer = config.issuer.replace(/\/$/, "");
    this.resource = config.resource;
    this.scopes = [...config.scopes];
    this.secret = config.secret;
    this.state = new OAuthStateStore(config.stateDbPath);
    this.accessTokenTtlMs = Math.max(60_000, config.accessTokenTtlMs ?? 15 * 60_000);
    this.grantTtlMs = Math.max(this.accessTokenTtlMs, config.grantTtlMs ?? 14 * 24 * 60 * 60_000);
    this.authorizationCodeTtlMs = Math.min(10 * 60_000, Math.max(30_000, config.authorizationCodeTtlMs ?? 5 * 60_000));
  }

  close(): void {
    this.state.close();
  }

  metadata(): Record<string, unknown> {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      registration_endpoint: `${this.issuer}/oauth/register`,
      revocation_endpoint: `${this.issuer}/oauth/revoke`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
      protected_resources: [this.resource],
      ...(this.scopes.length ? { scopes_supported: [...this.scopes] } : {}),
    };
  }

  async handleRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST", "cache-control": "no-store" }).end();
      return;
    }
    try {
      const input = await readJson(req) as DynamicClientRegistrationInput;
      const registration = await issueDynamicClientId(input, { issuer: this.issuer, secret: this.secret });
      json(res, 201, {
        client_id: registration.clientId,
        client_id_issued_at: registration.issuedAt,
        client_name: registration.metadata.clientName,
        redirect_uris: registration.metadata.redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      });
    } catch (error) {
      oauthError(res, 400, "invalid_client_metadata", error instanceof Error ? error.message : "invalid client metadata");
    }
  }

  async handleAuthorize(url: URL, res: ServerResponse): Promise<void> {
    try {
      if (url.searchParams.get("response_type") !== "code") throw new Error("response_type=code is required");
      const clientId = url.searchParams.get("client_id")?.trim() ?? "";
      const redirectUriRaw = url.searchParams.get("redirect_uri")?.trim() ?? "";
      const resource = url.searchParams.get("resource")?.trim() ?? "";
      const codeChallenge = url.searchParams.get("code_challenge")?.trim() ?? "";
      const codeChallengeMethod = url.searchParams.get("code_challenge_method")?.trim() ?? "";
      if (!clientId || !redirectUriRaw || !resource || !codeChallenge) throw new Error("client_id, redirect_uri, resource, and code_challenge are required");
      if (resource !== this.resource) throw new Error("resource does not match this MCP server");
      if (codeChallengeMethod !== "S256") throw new Error("code_challenge_method=S256 is required");
      const redirectUri = validateRedirectUri(redirectUriRaw);
      const client = await resolveOAuthClient(clientId, { issuer: this.issuer, secret: this.secret });
      if (!client.redirectUris.includes(redirectUri)) throw new Error("redirect_uri is not registered for this client");
      const scope = requestedScope(url.searchParams.get("scope"), this.scopes);
      const state = url.searchParams.get("state");
      const now = Math.floor(Date.now() / 1000);
      const ticket = await new SignJWT({
        typ: "authorization-request",
        client_id: client.clientId,
        client_name: client.clientName,
        redirect_uri: redirectUri,
        code_challenge: codeChallenge,
        resource,
        scope,
        state,
      })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setIssuer(this.issuer)
        .setAudience(`${this.issuer}/oauth/login`)
        .setIssuedAt(now)
        .setExpirationTime(now + 10 * 60)
        .sign(secretKey(this.secret));
      res.writeHead(302, { location: `${this.issuer}/oauth/login?ticket=${encodeURIComponent(ticket)}`, "cache-control": "no-store" }).end();
    } catch (error) {
      oauthError(res, 400, "invalid_request", error instanceof Error ? error.message : "invalid authorization request");
    }
  }

  private async verifyAuthorizationTicket(ticket: string): Promise<AuthorizationTicket> {
    const { payload } = await jwtVerify(ticket, secretKey(this.secret), {
      algorithms: ["HS256"],
      issuer: this.issuer,
      audience: `${this.issuer}/oauth/login`,
    });
    if (payload.typ !== "authorization-request") throw new Error("invalid authorization ticket");
    const details: AuthorizationTicket = {
      clientId: typeof payload.client_id === "string" ? payload.client_id : "",
      clientName: typeof payload.client_name === "string" ? payload.client_name : "",
      redirectUri: typeof payload.redirect_uri === "string" ? payload.redirect_uri : "",
      codeChallenge: typeof payload.code_challenge === "string" ? payload.code_challenge : "",
      resource: typeof payload.resource === "string" ? payload.resource : "",
      scope: typeof payload.scope === "string" ? payload.scope : "",
      state: typeof payload.state === "string" ? payload.state : null,
    };
    if (!details.clientId || !details.clientName || !details.redirectUri || !details.codeChallenge || details.resource !== this.resource) {
      throw new Error("authorization ticket is incomplete");
    }
    return details;
  }

  async handleLogin(req: IncomingMessage, url: URL, res: ServerResponse, identity: NativeOAuthIdentity): Promise<void> {
    try {
      if (req.method === "GET") {
        const ticket = url.searchParams.get("ticket") ?? "";
        if (!ticket) throw new Error("authorization ticket is required");
        const details = await this.verifyAuthorizationTicket(ticket);
        const client = await resolveOAuthClient(details.clientId, { issuer: this.issuer, secret: this.secret });
        if (!client.redirectUris.includes(details.redirectUri)) throw new Error("client registration changed during authorization");
        const body = consentHtml(ticket, details);
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
        }).end(body);
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, { allow: "GET, POST", "cache-control": "no-store" }).end();
        return;
      }
      const form = await readForm(req);
      const ticket = form.get("ticket") ?? "";
      const decision = form.get("decision") ?? "";
      const details = await this.verifyAuthorizationTicket(ticket);
      const client = await resolveOAuthClient(details.clientId, { issuer: this.issuer, secret: this.secret });
      if (!client.redirectUris.includes(details.redirectUri)) throw new Error("client registration changed during authorization");
      if (decision !== "approve") {
        res.writeHead(302, {
          location: appendRedirectParams(details.redirectUri, { error: "access_denied", state: details.state }),
          "cache-control": "no-store",
        }).end();
        return;
      }
      const codeRecord: AuthorizationCodeRecord = {
        clientId: details.clientId,
        redirectUri: details.redirectUri,
        codeChallenge: details.codeChallenge,
        resource: details.resource,
        scope: details.scope,
        subject: identity.subject,
        email: identity.email,
      };
      const code = this.state.issueAuthorizationCode(codeRecord, this.authorizationCodeTtlMs);
      res.writeHead(302, {
        location: appendRedirectParams(details.redirectUri, { code, state: details.state }),
        "cache-control": "no-store",
      }).end();
    } catch (error) {
      oauthError(res, 400, "invalid_request", error instanceof Error ? error.message : "invalid login request");
    }
  }

  private async issueAccessToken(record: Omit<RefreshTokenRecord, "familyId" | "expiresAt">): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return await new SignJWT({
      token_use: "access",
      client_id: record.clientId,
      scope: record.scope,
      ...(record.email ? { email: record.email } : {}),
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(this.issuer)
      .setAudience(record.resource)
      .setSubject(record.subject)
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(now + Math.floor(this.accessTokenTtlMs / 1000))
      .sign(secretKey(this.secret));
  }

  private async tokenResponse(
    res: ServerResponse,
    record: Omit<RefreshTokenRecord, "familyId" | "expiresAt">,
    refresh: { token: string; record: RefreshTokenRecord },
  ): Promise<void> {
    json(res, 200, {
      access_token: await this.issueAccessToken(record),
      token_type: "Bearer",
      expires_in: Math.floor(this.accessTokenTtlMs / 1000),
      refresh_token: refresh.token,
      scope: record.scope,
    });
  }

  async handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST", "cache-control": "no-store" }).end();
      return;
    }
    try {
      if (req.headers.authorization) throw new Error("token endpoint client authentication is not supported for public MCP clients");
      const form = await readForm(req);
      const grantType = form.get("grant_type") ?? "";
      const clientId = form.get("client_id")?.trim() ?? "";
      const resource = form.get("resource")?.trim() ?? "";
      if (!clientId || !resource) throw new Error("client_id and resource are required");
      if (resource !== this.resource) throw new Error("resource does not match this MCP server");
      await resolveOAuthClient(clientId, { issuer: this.issuer, secret: this.secret });

      if (grantType === "authorization_code") {
        const code = form.get("code") ?? "";
        const redirectUri = validateRedirectUri(form.get("redirect_uri") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        if (!code || !PKCE_VERIFIER.test(verifier)) throw new Error("code and a valid PKCE code_verifier are required");
        const record = this.state.consumeAuthorizationCode(code);
        if (!record) throw new Error("authorization code is invalid, expired, or already used");
        if (record.clientId !== clientId || record.redirectUri !== redirectUri || record.resource !== resource) {
          throw new Error("authorization code binding does not match the token request");
        }
        if (!safeEqual(pkceS256(verifier), record.codeChallenge)) throw new Error("PKCE verification failed");
        const tokenRecord = {
          clientId: record.clientId,
          resource: record.resource,
          scope: record.scope,
          subject: record.subject,
          email: record.email,
        };
        const refresh = this.state.issueRefreshToken(tokenRecord, Date.now() + this.grantTtlMs);
        await this.tokenResponse(res, tokenRecord, refresh);
        return;
      }

      if (grantType === "refresh_token") {
        const refreshToken = form.get("refresh_token") ?? "";
        if (!refreshToken) throw new Error("refresh_token is required");
        const rotated = this.state.rotateRefreshToken(refreshToken, { clientId, resource });
        if (!rotated) throw new Error("refresh token is invalid, expired, reused, or revoked");
        const record = {
          clientId: rotated.record.clientId,
          resource: rotated.record.resource,
          scope: rotated.record.scope,
          subject: rotated.record.subject,
          email: rotated.record.email,
        };
        await this.tokenResponse(res, record, rotated);
        return;
      }

      oauthError(res, 400, "unsupported_grant_type", "authorization_code and refresh_token grants are supported");
    } catch (error) {
      oauthError(res, 400, "invalid_grant", error instanceof Error ? error.message : "token request failed");
    }
  }

  async handleRevoke(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST", "cache-control": "no-store" }).end();
      return;
    }
    try {
      const form = await readForm(req);
      const token = form.get("token") ?? "";
      if (token.startsWith("cptr_refresh_")) this.state.revokeRefreshToken(token);
      json(res, 200, {});
    } catch {
      json(res, 200, {});
    }
  }
}
