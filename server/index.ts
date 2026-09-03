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
import {
  ComputerApiError,
  clientFromEnvironment,
  type BackendRequestObservation,
} from "./client/computer-client.js";
import { McpActivityEmitter } from "./mcp-activity.js";
import { McpDiagnosticsEmitter, sanitizeDiagnosticSummary } from "./mcp-diagnostics.js";
import {
  McpTrafficEmitter,
  mcpRequestContext,
  normalizeMcpClient,
  normalizeTrafficErrorCode,
  type McpRequestContextValue,
  type TrafficClient,
} from "./mcp-traffic.js";
import { MCP_CONTRACT_TOOL_COUNT, MCP_CONTRACT_VERSION, createMcpServer } from "./mcp.js";
import { currentPluginUpdateManifest } from "./release.js";
import { CPTR_APP_VERSION } from "./version.js";
import { LiveGateway } from "./live-gateway.js";
import { LiveTicketStore } from "./live-tickets.js";
import { PromptTerminalGateway, PromptTerminalStore, resolveLiveTerminalStreaming } from "./prompt-terminal.js";
import { PromptBrowserFrameGateway } from "./browser-frame-gateway.js";
import { PromptBrowserInputGateway } from "./browser-input-gateway.js";
import {
  isBrowserDevicePath,
  proxyBrowserDeviceHttp,
  proxyBrowserDeviceUpgrade,
  rejectBrowserDeviceUpgrade,
} from "./browser-device-proxy.js";
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
const cptrBaseUrl = process.env.CPTR_BASE_URL ?? "";
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
const mcpDiagnostics = new McpDiagnosticsEmitter({
  deliver: (events) => client.ingestMcpDiagnostics(events),
});
const mcpTraffic = new McpTrafficEmitter({
  deliver: (events) => client.ingestMcpTraffic(events),
  onDeliveryFailure: (_error, events) => {
    const first = events[0];
    mcpDiagnostics.failure({
      request_id: first?.request_id ?? null,
      correlation_id: first?.correlation_id ?? null,
      session_id: first?.session_id ?? null,
      client_id: first?.client.id ?? "chatgpt",
      method: first?.method ?? null,
      tool_name: first?.tool_name ?? null,
      stage: "traffic_delivery",
      error_code: "telemetry_delivery_failed",
      http_status: null,
      retryable: true,
      started_at_ms: null,
      duration_ms: null,
      request_bytes: first?.request_bytes ?? null,
      response_bytes: first?.response_bytes ?? null,
      summary: "MCP traffic delivery failed.",
    });
  },
});
const mcpActivity = new McpActivityEmitter({
  deliver: (events) => client.ingestMcpActivity(events),
  onDeliveryFailure: (_error, events) => {
    const first = events[0];
    mcpDiagnostics.failure({
      request_id: first?.request_id ?? null,
      correlation_id: first?.correlation_id ?? null,
      session_id: first?.session_id ?? null,
      client_id: first?.client.id ?? "chatgpt",
      method: null,
      tool_name: first?.tool_name ?? null,
      stage: "activity_delivery",
      error_code: "telemetry_delivery_failed",
      http_status: null,
      retryable: true,
      started_at_ms: null,
      duration_ms: first?.duration_ms ?? null,
      request_bytes: null,
      response_bytes: null,
      summary: "MCP activity delivery failed.",
    });
  },
});
client.setRequestObserver((observation: BackendRequestObservation) => {
  const context = mcpRequestContext.getStore();
  if (!context) return;
  const failed = observation.error !== null || (observation.status !== null && observation.status >= 400);
  mcpDiagnostics.latency({
    request_id: context.requestId,
    correlation_id: context.correlationId,
    edge_id: "cptr-mcp-cptr-backend",
    metric_type: "backend_api_rtt",
    duration_ms: observation.durationMs,
    status: failed ? "error" : "ok",
  });
  if (!failed) return;
  const error = observation.error;
  mcpDiagnostics.failure({
    request_id: context.requestId,
    correlation_id: context.correlationId,
    session_id: context.sessionId,
    client_id: context.client.id,
    method: context.method,
    tool_name: null,
    stage: "cptr_backend",
    error_code: error?.code ?? "backend_http_error",
    http_status: observation.status ?? error?.status ?? null,
    retryable: error?.retriable ?? (observation.status === null ? true : observation.status >= 500),
    started_at_ms: Math.max(0, Date.now() - observation.durationMs),
    duration_ms: observation.durationMs,
    request_bytes: null,
    response_bytes: null,
    summary: "CPTR backend request failed.",
  });
});
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
  browserFrameUrl: `${publicOrigin}/live/prompt/browser-frame`,
  browserInputUrl: `${publicOrigin}/live/prompt/browser-input`,
  // Prompt activity is intentionally lightweight and remains available even
  // when raw live-terminal streaming is disabled for chat/UI performance.
  streamingEnabled: true,
});
const promptGateway = new PromptTerminalGateway(promptSessions);
const browserFrameGateway = new PromptBrowserFrameGateway(client, promptSessions);
const browserInputGateway = new PromptBrowserInputGateway(client, promptSessions);

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

type ParsedJsonBody = { value: unknown; bytes: number };

async function readJsonBody(req: IncomingMessage, maxBytes = 2_000_000): Promise<ParsedJsonBody> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > maxBytes) throw new Error("MCP request body is too large");
    chunks.push(value);
  }
  if (!chunks.length) return { value: undefined, bytes: 0 };
  return { value: JSON.parse(Buffer.concat(chunks).toString("utf8")), bytes };
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function trafficClientFromRequest(
  req: IncomingMessage,
  body: unknown,
  fallback?: TrafficClient,
): TrafficClient {
  if (fallback) return fallback;
  const record = jsonRecord(body);
  const params = jsonRecord(record?.params);
  const clientInfo = jsonRecord(params?.clientInfo);
  if (clientInfo) {
    return normalizeMcpClient({ name: clientInfo.name, version: clientInfo.version });
  }
  const userAgent = Array.isArray(req.headers["user-agent"])
    ? req.headers["user-agent"][0]
    : req.headers["user-agent"];
  const key = String(userAgent ?? "").toLowerCase();
  if (key.includes("chatgpt")) return normalizeMcpClient({ name: "ChatGPT" });
  if (key.includes("claude")) return normalizeMcpClient({ name: "Claude" });
  if (key.includes("gemini")) return normalizeMcpClient({ name: "Gemini" });
  if (key.includes("codex")) return normalizeMcpClient({ name: "Codex" });
  if (key.includes("inspector")) return normalizeMcpClient({ name: "MCP Inspector" });
  return normalizeMcpClient({ name: "ChatGPT" });
}

function trafficMethod(req: IncomingMessage, body: unknown): string | null {
  const record = jsonRecord(body);
  if (typeof record?.method === "string") return record.method.slice(0, 128);
  if (req.method === "GET") return "transport/get";
  if (req.method === "DELETE") return "transport/delete";
  return null;
}

function rawToolArguments(body: unknown): unknown | undefined {
  const record = jsonRecord(body);
  if (record?.method !== "tools/call") return undefined;
  const params = jsonRecord(record.params);
  if (!params || !("arguments" in params)) return {};
  return params.arguments;
}

function emitClientTransportFailure(
  req: IncomingMessage,
  input: {
    errorCode: string;
    status: number | null;
    retryable: boolean | null;
    summary: string;
    requestBytes?: number | null;
  },
): void {
  const transportClient = trafficClientFromRequest(req, undefined);
  mcpDiagnostics.failure({
    request_id: null,
    correlation_id: null,
    session_id: null,
    client_id: transportClient.id,
    method: trafficMethod(req, undefined),
    tool_name: null,
    stage: "client_transport",
    error_code: input.errorCode,
    http_status: input.status,
    retryable: input.retryable,
    started_at_ms: null,
    duration_ms: null,
    request_bytes: input.requestBytes ?? null,
    response_bytes: null,
    summary: input.summary,
  });
}

function responseChunkBytes(chunk: unknown, encoding?: unknown): number {
  if (typeof chunk === "string") {
    const value = typeof encoding === "string" ? encoding as BufferEncoding : "utf8";
    return Buffer.byteLength(chunk, value);
  }
  if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) return chunk.byteLength;
  return 0;
}

type ResponseObservation = {
  bytes: () => number;
  statusCode: () => number;
  jsonRpcError: () => { code: string; message: string } | null;
  restore: () => void;
};

function responseChunkBuffer(chunk: unknown, encoding?: unknown): Buffer | null {
  if (typeof chunk === "string") {
    const value = typeof encoding === "string" ? encoding as BufferEncoding : "utf8";
    return Buffer.from(chunk, value);
  }
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return null;
}

function trackResponse(res: ServerResponse): ResponseObservation {
  let count = 0;
  let captured = Buffer.alloc(0);
  const maxCapturedBytes = 16_384;
  const originalWrite = res.write;
  const originalEnd = res.end;
  const observe = (chunk: unknown, encoding?: unknown) => {
    count += responseChunkBytes(chunk, encoding);
    if (captured.byteLength >= maxCapturedBytes) return;
    const buffer = responseChunkBuffer(chunk, encoding);
    if (!buffer) return;
    const remaining = maxCapturedBytes - captured.byteLength;
    captured = Buffer.concat([captured, buffer.subarray(0, remaining)]);
  };
  res.write = function (this: ServerResponse, ...args: Parameters<ServerResponse["write"]>) {
    observe(args[0], args[1]);
    return originalWrite.apply(this, args as never);
  } as ServerResponse["write"];
  res.end = function (this: ServerResponse, ...args: Parameters<ServerResponse["end"]>) {
    observe(args[0], args[1]);
    return originalEnd.apply(this, args as never);
  } as ServerResponse["end"];
  return {
    bytes: () => Math.min(100_000_000, count),
    statusCode: () => res.statusCode,
    jsonRpcError: () => {
      if (captured.byteLength === 0) return null;
      try {
        const payload = JSON.parse(captured.toString("utf8"));
        const record = jsonRecord(payload);
        const error = jsonRecord(record?.error);
        if (!error) return null;
        return {
          code: String(error.code ?? "json_rpc_error").slice(0, 64),
          message: sanitizeDiagnosticSummary(String(error.message ?? "MCP JSON-RPC error")),
        };
      } catch {
        return null;
      }
    },
    restore: () => {
      res.write = originalWrite;
      res.end = originalEnd;
      captured = Buffer.alloc(0);
    },
  };
}

async function handleWithTraffic(
  req: IncomingMessage,
  res: ServerResponse,
  input: {
    body: unknown;
    requestBytes: number | null;
    sessionId: string | null;
    client: TrafficClient;
  },
  run: (context: McpRequestContextValue) => Promise<void>,
): Promise<void> {
  const adapterSetupStartedAt = Date.now();
  const context: McpRequestContextValue = {
    requestId: randomUUID(),
    correlationId: randomUUID(),
    sessionId: input.sessionId,
    client: input.client,
    method: trafficMethod(req, input.body),
    startedAt: adapterSetupStartedAt,
    requestBytes: input.requestBytes,
    rawToolArguments: rawToolArguments(input.body),
    outcome: { failed: false, errorCode: null },
  };
  mcpTraffic.requestStarted({
    requestId: context.requestId,
    correlationId: context.correlationId,
    sessionId: context.sessionId,
    client: context.client,
    method: context.method,
    requestBytes: context.requestBytes,
  });
  const responseObservation = trackResponse(res);
  mcpDiagnostics.latency({
    request_id: context.requestId,
    correlation_id: context.correlationId,
    edge_id: "mcp-connector-cptr-mcp",
    metric_type: "adapter_handoff",
    duration_ms: Math.max(0, Date.now() - adapterSetupStartedAt),
    status: "ok",
  });
  let failed = false;
  try {
    await mcpRequestContext.run(context, () => run(context));
    const statusCode = responseObservation.statusCode();
    const jsonRpcError = responseObservation.jsonRpcError();
    if (context.outcome.failed) {
      failed = true;
      mcpTraffic.requestFailed(
        { ...context, responseBytes: responseObservation.bytes() },
        { code: context.outcome.errorCode, kind: context.outcome.errorCode },
      );
    } else if (statusCode >= 400 || jsonRpcError) {
      failed = true;
      const errorCode = jsonRpcError ? "tool_error" : normalizeTrafficErrorCode({ status: statusCode });
      context.outcome.failed = true;
      context.outcome.errorCode = errorCode;
      mcpTraffic.requestFailed(
        { ...context, responseBytes: responseObservation.bytes() },
        { status: statusCode, code: errorCode, kind: errorCode },
      );
      mcpDiagnostics.failure({
        request_id: context.requestId,
        correlation_id: context.correlationId,
        session_id: context.sessionId,
        client_id: context.client.id,
        method: context.method,
        tool_name: null,
        stage: "mcp_connector",
        error_code: jsonRpcError?.code ?? errorCode,
        http_status: statusCode >= 400 ? statusCode : null,
        retryable: statusCode >= 500,
        started_at_ms: context.startedAt,
        duration_ms: Math.max(0, Date.now() - context.startedAt),
        request_bytes: context.requestBytes,
        response_bytes: responseObservation.bytes(),
        summary: jsonRpcError
          ? "MCP JSON-RPC response reported an error."
          : "MCP connector request failed.",
      });
    } else {
      mcpTraffic.requestFinished({ ...context, responseBytes: responseObservation.bytes() });
    }
  } catch (error) {
    failed = true;
    if (!context.outcome.failed) {
      context.outcome.failed = true;
      context.outcome.errorCode = normalizeTrafficErrorCode(error);
    }
    mcpTraffic.requestFailed({ ...context, responseBytes: responseObservation.bytes() }, error);
    mcpDiagnostics.failure({
      request_id: context.requestId,
      correlation_id: context.correlationId,
      session_id: context.sessionId,
      client_id: context.client.id,
      method: context.method,
      tool_name: null,
      stage: "mcp_connector",
      error_code: context.outcome.errorCode ?? "internal_error",
      http_status: error instanceof ComputerApiError ? error.status : null,
      retryable: error instanceof ComputerApiError ? error.retriable : null,
      started_at_ms: context.startedAt,
      duration_ms: Math.max(0, Date.now() - context.startedAt),
      request_bytes: context.requestBytes,
      response_bytes: responseObservation.bytes(),
      summary: "MCP connector request failed.",
    });
    throw error;
  } finally {
    mcpDiagnostics.latency({
      request_id: context.requestId,
      correlation_id: context.correlationId,
      edge_id: "client-mcp-connector",
      metric_type: "observed_request_time",
      duration_ms: Math.max(0, Date.now() - context.startedAt),
      status: failed ? "error" : "ok",
    });
    responseObservation.restore();
  }
}

type McpSessionRecord = {
  transport: StreamableHTTPServerTransport;
  server: ReturnType<typeof createMcpServer>;
  authIdentity: string;
  trafficClient: TrafficClient;
  lastSeenAt: number;
};

const mcpSessions = new Map<string, McpSessionRecord>();
const maxMcpSessions = Math.max(1, Number(process.env.CPTR_MCP_MAX_SESSIONS ?? "128") || 128);
const mcpSessionIdleMs = Math.max(60_000, Number(process.env.CPTR_MCP_SESSION_IDLE_MS ?? String(30 * 60_000)) || 30 * 60_000);

function removeMcpSession(sessionId: string): McpSessionRecord | undefined {
  const record = mcpSessions.get(sessionId);
  if (!record) return undefined;
  mcpSessions.delete(sessionId);
  mcpTraffic.sessionClosed(sessionId, record.trafficClient);
  return record;
}

async function closeMcpSession(sessionId: string): Promise<void> {
  const record = removeMcpSession(sessionId);
  if (!record) return;
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
    traffic: mcpTraffic,
    activityTelemetry: mcpActivity,
    diagnostics: mcpDiagnostics,
  });
}

async function handleStatefulInitialize(
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
  requestBytes: number,
  identity: string,
): Promise<void> {
  await pruneMcpSessions();
  await evictMcpSessionIfFull();
  const trafficClient = trafficClientFromRequest(req, body);
  let initializedSessionId: string | null = null;
  let transport!: StreamableHTTPServerTransport;
  const server = createSessionServer();
  transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (sessionId) => {
      initializedSessionId = sessionId;
      const context = mcpRequestContext.getStore();
      if (context) context.sessionId = sessionId;
      mcpSessions.set(sessionId, {
        transport,
        server,
        authIdentity: identity,
        trafficClient,
        lastSeenAt: Date.now(),
      });
      mcpTraffic.sessionOpened(sessionId, trafficClient);
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
    if (!initializedSessionId) return;
    const record = removeMcpSession(initializedSessionId);
    if (record) void record.server.close().catch(() => undefined);
  };
  try {
    await server.connect(transport);
    await handleWithTraffic(
      req,
      res,
      { body, requestBytes, sessionId: null, client: trafficClient },
      async () => {
        await transport.handleRequest(req, res, body);
      },
    );
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
  requestBytes: number,
): Promise<void> {
  const trafficClient = trafficClientFromRequest(req, body);
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
    await handleWithTraffic(
      req,
      res,
      { body, requestBytes, sessionId: null, client: trafficClient },
      async () => {
        await transport.handleRequest(req, res, body);
      },
    );
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
    url.pathname === "/live/prompt/browser-frame" ||
    url.pathname === "/live/prompt/browser-input" ||
    url.pathname === "/live/prompt/browser-return" ||
    url.pathname === "/live/prompt/browser-stream" ||
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

  if (isBrowserDevicePath(url.pathname)) {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        ...originHeaders,
        "access-control-allow-headers": "Content-Type, Accept",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "cache-control": "no-store",
      }).end();
      return;
    }
    if (!req.method || !["GET", "POST"].includes(req.method)) {
      res.writeHead(405, { "cache-control": "no-store" }).end();
      return;
    }
    await proxyBrowserDeviceHttp(req, res, cptrBaseUrl);
    return;
  }

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
    url.pathname === "/live/prompt/snapshot" ||
    url.pathname === "/live/prompt/browser-frame" ||
    url.pathname === "/live/prompt/browser-input" ||
    url.pathname === "/live/prompt/browser-return" ||
    url.pathname === "/live/prompt/browser-stream"
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
    if (url.pathname === "/live/prompt/browser-input" || url.pathname === "/live/prompt/browser-return" || url.pathname === "/live/prompt/browser-stream") {
      if (req.method !== "POST") {
        res.writeHead(405, { "cache-control": "no-store" }).end();
        return;
      }
      await browserInputGateway.handle(req, res);
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { "cache-control": "no-store" }).end();
      return;
    }
    if (url.pathname === "/live/snapshot") await liveGateway.handleSnapshot(req, res);
    else if (url.pathname === "/live/stream") await liveGateway.handle(req, res);
    else if (url.pathname === "/live/prompt/snapshot") promptGateway.handleSnapshot(req, res);
    else if (url.pathname === "/live/prompt/browser-frame") await browserFrameGateway.handle(req, res);
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
    emitClientTransportFailure(req, {
      errorCode: status === 401 ? "unauthorized" : "authentication_unavailable",
      status,
      retryable: status >= 500,
      summary: status === 401 ? "MCP authentication failed." : "MCP authentication is unavailable.",
    });
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
        emitClientTransportFailure(req, {
          errorCode: "session_not_found",
          status: 404,
          retryable: false,
          summary: "MCP session was not found.",
        });
        writeJson(res, 404, { error: "MCP session not found; initialize a new session" });
        return;
      }
      if (session.authIdentity !== identity) {
        emitClientTransportFailure(req, {
          errorCode: "session_identity_mismatch",
          status: 403,
          retryable: false,
          summary: "MCP session identity did not match.",
        });
        writeJson(res, 403, { error: "MCP session identity mismatch" });
        return;
      }
      session.lastSeenAt = Date.now();
      const parsed = req.method === "POST"
        ? await readJsonBody(req)
        : { value: undefined, bytes: 0 };
      await handleWithTraffic(
        req,
        res,
        {
          body: parsed.value,
          requestBytes: req.method === "POST" ? parsed.bytes : null,
          sessionId: sessionHeader,
          client: session.trafficClient,
        },
        async () => {
          await session.transport.handleRequest(req, res, parsed.value);
        },
      );
      if (req.method === "DELETE") await closeMcpSession(sessionHeader);
      return;
    }

    if (req.method === "POST") {
      const parsed = await readJsonBody(req);
      if (isInitializeRequest(parsed.value)) {
        await handleStatefulInitialize(req, res, parsed.value, parsed.bytes, identity);
        return;
      }
      // Migration compatibility for a ChatGPT connection created before the
      // current contract. After connector metadata Refresh, initialize-capable
      // clients receive an Mcp-Session-Id and all prompt activity stays scoped.
      res.setHeader("X-CPTR-Contract-Refresh", `required-v${CPTR_APP_VERSION}`);
      await handleStatelessCompatibilityRequest(req, res, parsed.value, parsed.bytes);
      return;
    }

    emitClientTransportFailure(req, {
      errorCode: "session_id_required",
      status: 400,
      retryable: false,
      summary: "MCP session ID is required.",
    });
    writeJson(res, 400, { error: "MCP session ID is required for this request" });
  } catch (error) {
    const malformedJson = error instanceof SyntaxError;
    const oversized = error instanceof Error && error.message === "MCP request body is too large";
    if (malformedJson || oversized) {
      emitClientTransportFailure(req, {
        errorCode: oversized ? "request_too_large" : "malformed_json",
        status: oversized ? 413 : 400,
        retryable: false,
        summary: oversized ? "MCP request body is too large." : "MCP request body is malformed JSON.",
      });
    }
    console.error("MCP request failed", error instanceof Error ? error.message : "unknown error");
    if (!res.headersSent) writeJson(res, malformedJson ? 400 : oversized ? 413 : 500, { error: malformedJson ? "Malformed JSON" : oversized ? "Request body too large" : "Internal server error" });
  }
});

httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${port}`}`);
  if (!isBrowserDevicePath(url.pathname)) {
    socket.destroy();
    return;
  }
  const requestOrigin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  // Device WebSockets are browser-only and always require the exact configured
  // extension origin in addition to the device credential sent in the first frame.
  if (!requestOrigin || !isAllowedBrowserOrigin(requestOrigin, allowedBrowserOrigins)) {
    rejectBrowserDeviceUpgrade(socket);
    return;
  }
  proxyBrowserDeviceUpgrade(req, socket, head, cptrBaseUrl);
});

const sessionPruner = setInterval(() => {
  void pruneMcpSessions();
}, Math.min(60_000, Math.max(10_000, Math.floor(mcpSessionIdleMs / 4))));
sessionPruner.unref();

async function shutdown(signal: string) {
  console.log(`Shutting down ChatGPT Computer MCP server (${signal})`);
  clearInterval(sessionPruner);
  await Promise.all([...mcpSessions.keys()].map((sessionId) => closeMcpSession(sessionId)));
  const telemetryDeadline = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 1_000);
    timer.unref?.();
  });
  const closeTelemetry = Promise.all([
    mcpTraffic.close().catch(() => {
      console.warn("MCP traffic telemetry shutdown did not complete cleanly");
    }),
    mcpActivity.close().catch(() => {
      console.warn("MCP activity telemetry shutdown did not complete cleanly");
    }),
    mcpDiagnostics.close().catch(() => {
      console.warn("MCP diagnostics telemetry shutdown did not complete cleanly");
    }),
  ]);
  await Promise.race([closeTelemetry, telemetryDeadline]);
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
