import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  authenticateMcpRequest,
  createProtectedResourceMetadata,
  type McpAuthConfig,
} from "./auth.js";
import { clientFromEnvironment } from "./client/computer-client.js";
import { createMcpServer } from "./mcp.js";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? "8787");
const mcpPath = "/mcp";
const mcpAccessToken = process.env.MCP_ACCESS_TOKEN;
const publicOrigin = process.env.PUBLIC_ORIGIN ?? "https://mcp.tnaprovider.com.au";
const oauthResource = process.env.MCP_OAUTH_RESOURCE ?? `${publicOrigin}${mcpPath}`;
const oauthIssuer = process.env.CLOUDFLARE_ACCESS_ISSUER;
const oauthAudience = process.env.CLOUDFLARE_ACCESS_AUDIENCE;
const oauthAllowedEmail = process.env.MCP_OAUTH_ALLOWED_EMAIL;
const oauthJwksUri = process.env.CLOUDFLARE_ACCESS_JWKS_URI ??
  (oauthIssuer ? `${oauthIssuer.replace(/\/$/, "")}/cdn-cgi/access/certs` : undefined);
const oauthScopes = (process.env.MCP_OAUTH_SCOPES ?? "")
  .split(/[ ,]+/)
  .map((scope) => scope.trim())
  .filter(Boolean);
const oauthConfig: McpAuthConfig = {
  staticToken: mcpAccessToken,
  cloudflare:
    oauthIssuer && oauthAudience && oauthAllowedEmail && oauthJwksUri
      ? {
          issuer: oauthIssuer,
          audience: oauthAudience,
          resource: oauthResource,
          allowedEmail: oauthAllowedEmail,
          requiredScopes: oauthScopes,
          jwksUri: oauthJwksUri,
        }
      : undefined,
};
const client = clientFromEnvironment();

function writeJson(res: import("node:http").ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "Access-Control-Allow-Origin": "*",
    ...headers,
  }).end(JSON.stringify(value));
}

function writeMcpUnauthorized(res: import("node:http").ServerResponse, status: number, message: string) {
  const metadataUrl = `${publicOrigin}/.well-known/oauth-protected-resource`;
  writeJson(res, status, { error: message }, {
    "www-authenticate": `Bearer resource_metadata="${metadataUrl}"`,
  });
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${port}`}`);
  if (url.pathname === mcpPath && req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, Mcp-Session-Id",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    }).end();
    return;
  }
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (url.pathname === "/.well-known/oauth-protected-resource" && req.method === "GET") {
    if (!oauthIssuer) {
      writeJson(res, 404, { error: "OAuth is not configured" });
      return;
    }
    writeJson(res, 200, createProtectedResourceMetadata({
      resource: oauthResource,
      authorizationServer: oauthIssuer,
      scopes: oauthScopes,
    }));
    return;
  }
  if (url.pathname !== mcpPath || !req.method || !["GET", "POST", "DELETE"].includes(req.method)) {
    res.writeHead(404).end("Not Found");
    return;
  }

  const cloudflareAssertion = Array.isArray(req.headers["cf-access-jwt-assertion"])
    ? req.headers["cf-access-jwt-assertion"][0]
    : req.headers["cf-access-jwt-assertion"];
  const auth = await authenticateMcpRequest(
    { authorization: req.headers.authorization, cloudflareAssertion },
    oauthConfig,
  );
  if (!auth.authorized) {
    const status = mcpAccessToken || oauthConfig.cloudflare ? 401 : 503;
    writeMcpUnauthorized(res, status, status === 503 ? "MCP authentication is not configured" : "Unauthorized");
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, Mcp-Session-Id");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  const server = createMcpServer(client);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error("MCP request failed", error instanceof Error ? error.message : "unknown error");
    if (!res.headersSent) res.writeHead(500).end("Internal server error");
  }
});

httpServer.listen(port, host, () => {
  console.log(`ChatGPT Computer MCP server listening on http://${host}:${port}${mcpPath}`);
});
