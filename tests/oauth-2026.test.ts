import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
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
