import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
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

test("DCR preserves MCP 2026 application_type for native clients", async () => {
  const oauth = new NativeOAuthServer({
    issuer: "https://mcp.example.test",
    resource: "https://mcp.example.test/mcp",
    scopes: ["mcp"],
    secret: "s".repeat(48),
    stateDbPath: ":memory:",
  });
  const authServer = await listen(async (req, res) => {
    if (req.url === "/oauth/register") return oauth.handleRegister(req, res);
    res.writeHead(404).end();
  });

  try {
    const response = await fetch(`${authServer.origin}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Native MCP Client",
        redirect_uris: ["http://127.0.0.1:43123/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        application_type: "native",
      }),
    });
    assert.equal(response.status, 201);
    const body = await response.json() as { application_type?: string };
    assert.equal(body.application_type, "native");
  } finally {
    await authServer.close();
    oauth.close();
  }
});

test("DCR accepts Claude, Gemini, and Grok-compatible redirect shapes", async () => {
  const oauth = new NativeOAuthServer({
    issuer: "https://mcp.example.test",
    resource: "https://mcp.example.test/mcp",
    scopes: ["mcp"],
    secret: "s".repeat(48),
    stateDbPath: ":memory:",
  });
  const authServer = await listen(async (req, res) => {
    if (req.url === "/oauth/register") return oauth.handleRegister(req, res);
    res.writeHead(404).end();
  });

  const clients = [
    {
      client_name: "Claude",
      redirect_uris: [
        "https://claude.ai/api/mcp/auth_callback",
        "https://claude.com/api/mcp/auth_callback",
      ],
      application_type: "web",
    },
    {
      client_name: "Gemini CLI",
      redirect_uris: ["http://localhost:43123/oauth/callback"],
      application_type: "native",
    },
    {
      client_name: "Grok hosted MCP connector",
      redirect_uris: ["https://grok.com/connectors/oauth/callback"],
      application_type: "web",
    },
  ] as const;

  try {
    for (const client of clients) {
      const response = await fetch(`${authServer.origin}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...client,
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      });
      assert.equal(response.status, 201, `${client.client_name} registration should succeed`);
      const body = await response.json() as {
        client_id?: string;
        redirect_uris?: string[];
        application_type?: string;
      };
      assert.match(body.client_id ?? "", /^urn:cptr:oauth-client:/);
      assert.deepEqual(body.redirect_uris, [...client.redirect_uris]);
      assert.equal(body.application_type, client.application_type);
    }
  } finally {
    await authServer.close();
    oauth.close();
  }
});

test("authorization response returns RFC 9207 iss bound to the OAuth issuer", async () => {
  const issuer = "https://mcp.example.test";
  const resource = `${issuer}/mcp`;
  const redirectUri = "http://127.0.0.1:43123/callback";
  const oauth = new NativeOAuthServer({
    issuer,
    resource,
    scopes: ["mcp"],
    secret: "s".repeat(48),
    stateDbPath: ":memory:",
  });
  const authServer = await listen(async (req, res) => {
    const url = new URL(req.url ?? "/", issuer);
    if (url.pathname === "/oauth/register") return oauth.handleRegister(req, res);
    if (url.pathname === "/oauth/authorize") return oauth.handleAuthorize(url, res);
    if (url.pathname === "/oauth/login") return oauth.handleLogin(req, url, res, { subject: "user-1", email: "user@example.test" });
    res.writeHead(404).end();
  });

  try {
    const registration = await fetch(`${authServer.origin}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Native MCP Client",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        application_type: "native",
      }),
    });
    assert.equal(registration.status, 201);
    const registered = await registration.json() as { client_id: string };

    const verifier = "v".repeat(64);
    const authorize = new URL(`${authServer.origin}/oauth/authorize`);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", registered.client_id);
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("resource", resource);
    authorize.searchParams.set("scope", "mcp");
    authorize.searchParams.set("code_challenge", pkceS256(verifier));
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("state", "state-2026");
    const authorization = await fetch(authorize, { redirect: "manual" });
    assert.equal(authorization.status, 302);
    const ticket = new URL(authorization.headers.get("location") ?? "").searchParams.get("ticket");
    assert.ok(ticket);

    const approved = await fetch(`${authServer.origin}/oauth/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ticket, decision: "approve" }),
      redirect: "manual",
    });
    assert.equal(approved.status, 302);
    const callback = new URL(approved.headers.get("location") ?? "");
    assert.equal(callback.searchParams.get("state"), "state-2026");
    assert.equal(callback.searchParams.get("iss"), issuer);
  } finally {
    await authServer.close();
    oauth.close();
  }
});
