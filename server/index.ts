import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  authenticateMcpRequest,
  createProtectedResourceMetadata,
  type McpAuthConfig,
  type McpAuthResult,
} from "./auth.js";
import { clientFromEnvironment } from "./client/computer-client.js";
import { MCP_CONTRACT_TOOL_COUNT, MCP_CONTRACT_VERSION, createMcpServer } from "./mcp.js";
import { currentPluginUpdateManifest } from "./release.js";
import { CPTR_APP_VERSION } from "./version.js";
import { LiveGateway } from "./live-gateway.js";
import { LiveTicketStore } from "./live-tickets.js";
import { PromptTerminalGateway, PromptTerminalStore, resolveLiveTerminalStreaming } from "./prompt-terminal.js";
import { loadWorkbenchAssets, resolveWorkbenchHotReload } from "./workbench-assets.js";
import {
  corsHeaders,
  isAllowedBrowserOrigin,
  isAllowedWorkbenchBrowserOrigin,
  resolveAllowedOrigins,
  resolvePublicOrigin,
  workbenchCorsHeaders,
} from "./http-security.js";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? "8787");
const mcpPath = "/mcp";
const mcpAccessToken = process.env.MCP_ACCESS_TOKEN;
const publicOrigin = resolvePublicOrigin(process.env, host, port);
const allowedBrowserOrigins = resolveAllowedOrigins(process.env);
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
const liveTerminalStreamingEnabled = resolveLiveTerminalStreaming();
const liveTickets = new LiveTicketStore({
  streamUrl: `${publicOrigin}/live/stream`,
  snapshotUrl: `${publicOrigin}/live/snapshot`,
  renewUrl: `${publicOrigin}/live/renew`,
});
const liveGateway = new LiveGateway(client, liveTickets);
const promptSessions = new PromptTerminalStore({
  streamUrl: `${publicOrigin}/live/prompt/stream`,
  snapshotUrl: `${publicOrigin}/live/prompt/snapshot`,
  // Prompt activity is intentionally lightweight and remains available even
  // when raw live-terminal streaming is disabled for chat/UI performance.
  streamingEnabled: true,
});
const promptGateway = new PromptTerminalGateway(promptSessions);

function currentWorkbenchAssets() {
  return loadWorkbenchAssets();
}

function currentWorkbenchHotReload() {
  return resolveWorkbenchHotReload(currentWorkbenchAssets());
}

const initialAssets = currentWorkbenchAssets();
const initialHotReload = resolveWorkbenchHotReload(initialAssets);
if (initialHotReload.enabled) allowedBrowserOrigins.add(publicOrigin);
if (!initialAssets.ready) {
  console.error(`CPTR Live Workbench bundle is unavailable; searched: ${initialAssets.searchedDirectories.join(", ")}`);
} else {
  console.log(`CPTR Live Workbench bundle loaded from ${initialAssets.directory}`);
}

function writeJson(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "Access-Control-Allow-Origin": "*",
    ...headers,
  }).end(JSON.stringify(value));
}

function writeMcpUnauthorized(res: ServerResponse, status: number, message: string) {
  const metadataUrl = `${publicOrigin}/.well-known/oauth-protected-resource`;
  writeJson(res, status, { error: message }, {
    "www-authenticate": `Bearer resource_metadata="${metadataUrl}"`,
  });
}

function authIdentity(auth: Extract<McpAuthResult, { authorized: true }>): string {
  return auth.mechanism === "cloudflare"
    ? `cloudflare:${auth.subject}:${auth.email}`
    : "static:configured-token";
}

async function readJsonBody(req: IncomingMessage, maxBytes = 2_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > maxBytes) throw new Error("MCP request body is too large");
    chunks.push(value);
  }
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

type McpSessionRecord = {
  transport: StreamableHTTPServerTransport;
  server: ReturnType<typeof createMcpServer>;
  authIdentity: string;
  lastSeenAt: number;
};

const mcpSessions = new Map<string, McpSessionRecord>();
const maxMcpSessions = Math.max(1, Number(process.env.CPTR_MCP_MAX_SESSIONS ?? "128") || 128);
const mcpSessionIdleMs = Math.max(60_000, Number(process.env.CPTR_MCP_SESSION_IDLE_MS ?? String(30 * 60_000)) || 30 * 60_000);

async function closeMcpSession(sessionId: string): Promise<void> {
  const record = mcpSessions.get(sessionId);
  if (!record) return;
  mcpSessions.delete(sessionId);
  await record.transport.close().catch(() => undefined);
  await record.server.close().catch(() => undefined);
}

async function pruneMcpSessions(now = Date.now()): Promise<void> {
  const expired = [...mcpSessions.entries()]
    .filter(([, record]) => now - record.lastSeenAt >= mcpSessionIdleMs)
    .map(([sessionId]) => sessionId);
  await Promise.all(expired.map((sessionId) => closeMcpSession(sessionId)));
}

async function evictMcpSessionIfFull(): Promise<void> {
  if (mcpSessions.size < maxMcpSessions) return;
  const oldest = [...mcpSessions.entries()]
    .sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)[0]?.[0];
  if (oldest) await closeMcpSession(oldest);
}

function createSessionServer() {
  return createMcpServer(client, {
    tickets: liveTickets,
    promptSessions,
    liveTerminalStreamingEnabled,
    widgetAssets: () => {
      const assets = currentWorkbenchAssets();
      return { bundle: assets.bundle, styles: assets.styles };
    },
    connectDomain: publicOrigin,
  });
}

async function handleStatefulInitialize(
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
  identity: string,
): Promise<void> {
  await pruneMcpSessions();
  await evictMcpSessionIfFull();
  let initializedSessionId: string | null = null;
  let transport!: StreamableHTTPServerTransport;
  const server = createSessionServer();
  transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (sessionId) => {
      initializedSessionId = sessionId;
      mcpSessions.set(sessionId, {
        transport,
        server,
        authIdentity: identity,
        lastSeenAt: Date.now(),
      });
      if (process.env.CPTR_NOTIFY_TOOL_LIST_CHANGED !== "0") {
        const timer = setTimeout(() => {
          try {
            server.sendToolListChanged();
          } catch {
            // ChatGPT currently keeps approved action snapshots host-controlled; notification is best-effort.
          }
        }, 250);
        timer.unref?.();
      }
    },
  });
  transport.onclose = () => {
    if (initializedSessionId) mcpSessions.delete(initializedSessionId);
  };
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (error) {
    if (initializedSessionId) await closeMcpSession(initializedSessionId);
    else {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
    throw error;
  }
}

async function handleStatelessCompatibilityRequest(
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
): Promise<void> {
  const server = createSessionServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const close = () => {
    void transport.close();
    void server.close();
  };
  res.once("close", close);
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } finally {
    if (res.writableEnded) {
      res.removeListener("close", close);
      close();
    }
  }
}

let hotReloadClients = 0;
const maxHotReloadClients = 32;

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${port}`}`);
  const requestOrigin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  const workbenchBrowserRequest =
    url.pathname === "/live/stream" ||
    url.pathname === "/live/snapshot" ||
    url.pathname === "/live/renew" ||
    url.pathname === "/live/prompt/stream" ||
    url.pathname === "/live/prompt/snapshot" ||
    url.pathname.startsWith("/__cptr/dev/");
  const browserOriginAllowed = workbenchBrowserRequest
    ? isAllowedWorkbenchBrowserOrigin(requestOrigin, allowedBrowserOrigins)
    : isAllowedBrowserOrigin(requestOrigin, allowedBrowserOrigins);
  if (!browserOriginAllowed) {
    res.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" })
      .end(JSON.stringify({ error: "browser origin is not allowed" }));
    return;
  }
  const originHeaders = workbenchBrowserRequest
    ? workbenchCorsHeaders(requestOrigin, allowedBrowserOrigins)
    : corsHeaders(requestOrigin, allowedBrowserOrigins);
  for (const [header, value] of Object.entries(originHeaders)) res.setHeader(header, value);

  const hotReload = currentWorkbenchHotReload();
  if (hotReload.enabled && req.method === "GET" && url.pathname === "/__cptr/dev/workbench.js") {
    const assets = currentWorkbenchAssets();
    res.writeHead(assets.ready ? 200 : 503, {
      ...originHeaders,
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
    }).end(assets.bundle);
    return;
  }
  if (hotReload.enabled && req.method === "GET" && url.pathname === "/__cptr/dev/workbench.css") {
    const assets = currentWorkbenchAssets();
    res.writeHead(assets.ready ? 200 : 503, {
      ...originHeaders,
      "content-type": "text/css; charset=utf-8",
      "cache-control": "no-store",
    }).end(assets.styles);
    return;
  }
  if (hotReload.enabled && req.method === "GET" && url.pathname === "/__cptr/dev/reload") {
    if (hotReloadClients >= maxHotReloadClients) {
      writeJson(res, 429, { error: "workbench reload stream capacity reached" });
      return;
    }
    hotReloadClients += 1;
    res.writeHead(200, {
      ...originHeaders,
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    let currentBuildId = hotReload.buildId;
    let heartbeatAt = Date.now();
    res.write(`retry: 1000\ndata: ${currentBuildId}\n\n`);
    const timer = setInterval(() => {
      if (res.destroyed) return;
      const next = currentWorkbenchHotReload();
      if (!next.enabled) {
        clearInterval(timer);
        res.end();
        return;
      }
      if (next.buildId !== currentBuildId) {
        currentBuildId = next.buildId;
        res.write(`data: ${currentBuildId}\n\n`);
      } else if (Date.now() - heartbeatAt >= 15_000) {
        heartbeatAt = Date.now();
        res.write(": hot-reload\n\n");
      }
    }, 750);
    req.once("close", () => {
      clearInterval(timer);
      hotReloadClients = Math.max(0, hotReloadClients - 1);
    });
    return;
  }

  if (url.pathname === mcpPath && req.method === "OPTIONS") {
    res.writeHead(204, {
      ...originHeaders,
      "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, Mcp-Session-Id, MCP-Protocol-Version",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    }).end();
    return;
  }

  if (url.pathname === "/plugin/update" && req.method === "GET") {
    writeJson(res, 200, currentPluginUpdateManifest());
    return;
  }

  if (url.pathname === "/health") {
    const assets = currentWorkbenchAssets();
    const reload = resolveWorkbenchHotReload(assets);
    const status = assets.ready ? 200 : 503;
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({
      status: assets.ready ? "ok" : "degraded",
      app_version: CPTR_APP_VERSION,
      workbench: {
        ready: assets.ready,
        asset_directory: assets.directory,
        hot_reload: reload.enabled,
        build_id: reload.buildId,
      },
      mcp_contract: {
        version: MCP_CONTRACT_VERSION,
        tool_count: MCP_CONTRACT_TOOL_COUNT,
        session_mode: "stateful-with-stateless-migration-fallback",
        active_sessions: mcpSessions.size,
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

  if (
    url.pathname === "/live/stream" ||
    url.pathname === "/live/snapshot" ||
    url.pathname === "/live/renew" ||
    url.pathname === "/live/prompt/stream" ||
    url.pathname === "/live/prompt/snapshot"
  ) {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        ...originHeaders,
        "access-control-allow-headers": "Authorization, Accept, Last-Event-ID, Content-Type",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "cache-control": "no-store",
      }).end();
      return;
    }
    if (url.pathname === "/live/renew") {
      if (req.method !== "POST") {
        res.writeHead(405, { "cache-control": "no-store" }).end();
        return;
      }
      await liveGateway.handleRenew(req, res);
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { "cache-control": "no-store" }).end();
      return;
    }
    if (url.pathname === "/live/snapshot") await liveGateway.handleSnapshot(req, res);
    else if (url.pathname === "/live/stream") await liveGateway.handle(req, res);
    else if (url.pathname === "/live/prompt/snapshot") promptGateway.handleSnapshot(req, res);
    else await promptGateway.handleStream(req, res);
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
  const identity = authIdentity(auth);

  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, Mcp-Session-Id, MCP-Protocol-Version");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

  try {
    const sessionHeader = Array.isArray(req.headers["mcp-session-id"])
      ? req.headers["mcp-session-id"][0]
      : req.headers["mcp-session-id"];

    if (sessionHeader) {
      const session = mcpSessions.get(sessionHeader);
      if (!session) {
        writeJson(res, 404, { error: "MCP session not found; initialize a new session" });
        return;
      }
      if (session.authIdentity !== identity) {
        writeJson(res, 403, { error: "MCP session identity mismatch" });
        return;
      }
      session.lastSeenAt = Date.now();
      const body = req.method === "POST" ? await readJsonBody(req) : undefined;
      await session.transport.handleRequest(req, res, body);
      if (req.method === "DELETE") await closeMcpSession(sessionHeader);
      return;
    }

    if (req.method === "POST") {
      const body = await readJsonBody(req);
      if (isInitializeRequest(body)) {
        await handleStatefulInitialize(req, res, body, identity);
        return;
      }
      // Migration compatibility for a ChatGPT connection created before the
      // current contract. After connector metadata Refresh, initialize-capable
      // clients receive an Mcp-Session-Id and all prompt activity stays scoped.
      res.setHeader("X-CPTR-Contract-Refresh", `required-v${CPTR_APP_VERSION}`);
      await handleStatelessCompatibilityRequest(req, res, body);
      return;
    }

    writeJson(res, 400, { error: "MCP session ID is required for this request" });
  } catch (error) {
    console.error("MCP request failed", error instanceof Error ? error.message : "unknown error");
    if (!res.headersSent) writeJson(res, 500, { error: "Internal server error" });
  }
});

const sessionPruner = setInterval(() => {
  void pruneMcpSessions();
}, Math.min(60_000, Math.max(10_000, Math.floor(mcpSessionIdleMs / 4))));
sessionPruner.unref();

async function shutdown(signal: string) {
  console.log(`Shutting down ChatGPT Computer MCP server (${signal})`);
  clearInterval(sessionPruner);
  await Promise.all([...mcpSessions.keys()].map((sessionId) => closeMcpSession(sessionId)));
  httpServer.close();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void shutdown(signal).finally(() => process.exit(0));
  });
}

httpServer.listen(port, host, () => {
  console.log(`ChatGPT Computer MCP server listening on http://${host}:${port}${mcpPath}`);
});
