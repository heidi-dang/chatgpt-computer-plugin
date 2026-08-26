import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  authenticateMcpRequest,
  createProtectedResourceMetadata,
  type McpAuthConfig,
} from "./auth.js";
import { clientFromEnvironment } from "./client/computer-client.js";
import { MCP_CONTRACT_TOOL_COUNT, MCP_CONTRACT_VERSION, createMcpServer } from "./mcp.js";
import { LiveGateway } from "./live-gateway.js";
import { LiveTicketStore } from "./live-tickets.js";
import { loadWorkbenchAssets } from "./workbench-assets.js";
import {
  corsHeaders,
  isAllowedBrowserOrigin,
  resolveAllowedOrigins,
  resolvePublicOrigin,
} from "./http-security.js";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? "8787");
const mcpPath = "/mcp";
const mcpAccessToken = process.env.MCP_ACCESS_TOKEN;
const publicOrigin = resolvePublicOrigin(process.env, host, port);
const allowedBrowserOrigins = resolveAllowedOrigins(process.env);
const hotReloadEnabled = process.env.NODE_ENV !== "production" && process.env.CPTR_HOT_RELOAD === "1";
const devBuildId = process.env.CPTR_DEV_BUILD_ID ?? "dev";
if (hotReloadEnabled) allowedBrowserOrigins.add(publicOrigin);
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
const liveTickets = new LiveTicketStore({
  streamUrl: `${publicOrigin}/live/stream`,
  snapshotUrl: `${publicOrigin}/live/snapshot`,
});
const liveGateway = new LiveGateway(client, liveTickets);
const workbenchAssets = loadWorkbenchAssets();
if (!workbenchAssets.ready) {
  console.error(`CPTR Live Workbench bundle is unavailable; searched: ${workbenchAssets.searchedDirectories.join(", ")}`);
} else {
  console.log(`CPTR Live Workbench bundle loaded from ${workbenchAssets.directory}`);
}

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
  const requestOrigin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  if (!isAllowedBrowserOrigin(requestOrigin, allowedBrowserOrigins)) {
    res.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ error: "browser origin is not allowed" }));
    return;
  }
  const originHeaders = corsHeaders(requestOrigin, allowedBrowserOrigins);
  for (const [header, value] of Object.entries(originHeaders)) res.setHeader(header, value);
  if (hotReloadEnabled && req.method === "GET" && url.pathname === "/__cptr/dev/workbench.js") {
    res.writeHead(workbenchAssets.ready ? 200 : 503, {
      ...originHeaders,
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
    }).end(workbenchAssets.bundle);
    return;
  }
  if (hotReloadEnabled && req.method === "GET" && url.pathname === "/__cptr/dev/workbench.css") {
    res.writeHead(workbenchAssets.ready ? 200 : 503, {
      ...originHeaders,
      "content-type": "text/css; charset=utf-8",
      "cache-control": "no-store",
    }).end(workbenchAssets.styles);
    return;
  }
  if (hotReloadEnabled && req.method === "GET" && url.pathname === "/__cptr/dev/reload") {
    res.writeHead(200, {
      ...originHeaders,
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(`data: ${devBuildId}\n\n`);
    const heartbeat = setInterval(() => res.write(": hot-reload\n\n"), 15_000);
    req.once("close", () => clearInterval(heartbeat));
    return;
  }
  if (url.pathname === mcpPath && req.method === "OPTIONS") {
    res.writeHead(204, {
      ...originHeaders,
      "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, Mcp-Session-Id",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    }).end();
    return;
  }
  if (url.pathname === "/health") {
    const status = workbenchAssets.ready ? 200 : 503;
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({
      status: workbenchAssets.ready ? "ok" : "degraded",
      workbench: {
        ready: workbenchAssets.ready,
        asset_directory: workbenchAssets.directory,
      },
      mcp_contract: {
        version: MCP_CONTRACT_VERSION,
        tool_count: MCP_CONTRACT_TOOL_COUNT,
      },
      release: process.env.GIT_COMMIT_SHA ?? process.env.RAILWAY_GIT_COMMIT_SHA ?? null,
    }));
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
  if (url.pathname === "/live/stream" || url.pathname === "/live/snapshot") {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        ...originHeaders,
        "access-control-allow-headers": "Authorization, Accept, Last-Event-ID",
        "access-control-allow-methods": "GET, OPTIONS",
        "cache-control": "no-store",
      }).end();
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { "cache-control": "no-store" }).end();
      return;
    }
    if (url.pathname === "/live/snapshot") await liveGateway.handleSnapshot(req, res);
    else await liveGateway.handle(req, res);
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

  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, Mcp-Session-Id");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  const server = createMcpServer(client, {
    tickets: liveTickets,
    widgetBundle: workbenchAssets.bundle,
    widgetStyles: workbenchAssets.styles,
    connectDomain: publicOrigin,
  });
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
