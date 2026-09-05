import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import { authenticateMcpRequest } from "../server/auth.js";
import { pkceS256 } from "../server/oauth-client-metadata.js";
import { NativeOAuthServer } from "../server/oauth-server.js";

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const server = createServer((req, res) => void Promise.resolve(handler(req, res)).catch((error) => {
    res.writeHead(500).end(String(error));
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test("native OAuth metadata advertises CIMD, DCR, PKCE, refresh tokens, and protected resource", () => {
  const oauth = new NativeOAuthServer({
    issuer: "https://mcp.example.test",
    resource: "https://mcp.example.test/mcp",
    scopes: ["mcp"],
    secret: "s".repeat(48),
    stateDbPath: ":memory:",
  });
  try {
    const metadata = oauth.metadata();
    assert.equal(metadata.client_id_metadata_document_supported, true);
    assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
    assert.deepEqual(metadata.grant_types_supported, ["authorization_code", "refresh_token"]);
    assert.equal(metadata.registration_endpoint, "https://mcp.example.test/oauth/register");
    assert.deepEqual(metadata.protected_resources, ["https://mcp.example.test/mcp"]);
  } finally {
    oauth.close();
  }
});

test("DCR authorization-code flow binds resource and PKCE and rotates refresh tokens", async () => {
  const secret = "s".repeat(48);
  const issuer = "https://mcp.example.test";
  const resource = `${issuer}/mcp`;
  const oauth = new NativeOAuthServer({
    issuer,
    resource,
    scopes: ["mcp"],
    secret,
    stateDbPath: ":memory:",
    accessTokenTtlMs: 60_000,
    grantTtlMs: 600_000,
  });
  const client = await listen((req, res) => {
    res.writeHead(204).end();
  });
  const redirectUri = `${client.origin}/callback`;
  const authServer = await listen(async (req, res) => {
    const url = new URL(req.url ?? "/", issuer);
    if (url.pathname === "/oauth/register") return oauth.handleRegister(req, res);
    if (url.pathname === "/oauth/authorize") return oauth.handleAuthorize(url, res);
    if (url.pathname === "/oauth/login") return oauth.handleLogin(req, url, res, { subject: "user-1", email: "user@example.test" });
    if (url.pathname === "/oauth/token") return oauth.handleToken(req, res);
    res.writeHead(404).end();
  });

  try {
    const registration = await fetch(`${authServer.origin}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "ChatGPT Test Client",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    assert.equal(registration.status, 201);
    const registered = await registration.json() as { client_id: string };
    assert.match(registered.client_id, /^urn:cptr:oauth-client:/);

    const verifier = "v".repeat(64);
    const authorize = new URL(`${authServer.origin}/oauth/authorize`);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", registered.client_id);
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("resource", resource);
    authorize.searchParams.set("scope", "mcp");
    authorize.searchParams.set("code_challenge", pkceS256(verifier));
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("state", "state-1");
    const authorization = await fetch(authorize, { redirect: "manual" });
    assert.equal(authorization.status, 302);
    const loginLocation = authorization.headers.get("location");
    assert.ok(loginLocation);
    const ticket = new URL(loginLocation).searchParams.get("ticket");
    assert.ok(ticket);

    const consent = await fetch(`${authServer.origin}/oauth/login?ticket=${encodeURIComponent(ticket)}`);
    assert.equal(consent.status, 200);
    assert.match(await consent.text(), /Authorize CPTR Computer/);

    const approved = await fetch(`${authServer.origin}/oauth/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ticket, decision: "approve" }),
      redirect: "manual",
    });
    assert.equal(approved.status, 302);
    const callback = new URL(approved.headers.get("location") ?? "");
    assert.equal(callback.origin, client.origin);
    assert.equal(callback.searchParams.get("state"), "state-1");
    const code = callback.searchParams.get("code");
    assert.ok(code);

    const token = await fetch(`${authServer.origin}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: registered.client_id,
        redirect_uri: redirectUri,
        code,
        code_verifier: verifier,
        resource,
      }),
    });
    assert.equal(token.status, 200);
    const tokenBody = await token.json() as { access_token: string; refresh_token: string; token_type: string; scope: string };
    assert.equal(tokenBody.token_type, "Bearer");
    assert.equal(tokenBody.scope, "mcp");
    assert.ok(tokenBody.refresh_token);

    const authenticated = await authenticateMcpRequest(
      { authorization: `Bearer ${tokenBody.access_token}` },
      { staticToken: undefined, cloudflare: undefined, nativeOAuth: { issuer, audience: resource, secret } },
    );
    assert.deepEqual(authenticated, {
      authorized: true,
      mechanism: "native-oauth",
      subject: "user-1",
      clientId: registered.client_id,
      scope: "mcp",
    });

    const refreshed = await fetch(`${authServer.origin}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: registered.client_id,
        refresh_token: tokenBody.refresh_token,
        resource,
      }),
    });
    assert.equal(refreshed.status, 200);
    const refreshedBody = await refreshed.json() as { refresh_token: string };
    assert.notEqual(refreshedBody.refresh_token, tokenBody.refresh_token);

    const reused = await fetch(`${authServer.origin}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: registered.client_id,
        refresh_token: tokenBody.refresh_token,
        resource,
      }),
    });
    assert.equal(reused.status, 400);

    const familyRevoked = await fetch(`${authServer.origin}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: registered.client_id,
        refresh_token: refreshedBody.refresh_token,
        resource,
      }),
    });
    assert.equal(familyRevoked.status, 400);
  } finally {
    await authServer.close();
    await client.close();
    oauth.close();
  }
});

test("OAuth token handling never logs credentials or grant material", async () => {
  const oauth = new NativeOAuthServer({
    issuer: "https://mcp.example.test",
    resource: "https://mcp.example.test/mcp",
    scopes: ["mcp"],
    secret: "s".repeat(48),
    stateDbPath: ":memory:",
  });
  const authServer = await listen(async (req, res) => {
    if (req.url === "/oauth/token") return oauth.handleToken(req, res);
    res.writeHead(404).end();
  });
  const originalLog = console.log;
  const captured: unknown[][] = [];
  console.log = (...args: unknown[]) => { captured.push(args); };

  try {
    const response = await fetch(`${authServer.origin}/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: "Bearer must-not-be-logged",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: "invalid-client",
        refresh_token: "refresh-secret-must-not-be-logged",
        resource: "https://mcp.example.test/mcp",
      }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(captured, []);
  } finally {
    console.log = originalLog;
    await authServer.close();
    oauth.close();
  }
});
