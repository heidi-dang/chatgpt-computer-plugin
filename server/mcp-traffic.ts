import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export type TrafficClient = {
  id: string;
  label: string;
  version: string | null;
  session_name: string | null;
  model: string | null;
  workspace_id: string | null;
  workspace_name: string | null;
};

export type McpTrafficErrorCode =
  | "timeout"
  | "validation_error"
  | "unauthorized"
  | "tool_error"
  | "transport_error"
  | "internal_error";

export type McpTrafficEventType =
  | "session_opened"
  | "session_closed"
  | "request_started"
  | "request_finished"
  | "request_failed"
  | "tool_started"
  | "tool_finished"
  | "tool_failed";

export type McpTrafficEvent = {
  version: 1;
  event_id: string;
  sequence: number;
  event_type: McpTrafficEventType;
  timestamp_ms: number;
  session_id: string | null;
  client: TrafficClient;
  request_id: string | null;
  correlation_id: string | null;
  method: string | null;
  tool_name: string | null;
  status: "started" | "complete" | "error" | "connected" | "disconnected";
  duration_ms: number | null;
  request_bytes: number | null;
  response_bytes: number | null;
  error_code: McpTrafficErrorCode | null;
};

export type McpRequestContextValue = {
  requestId: string;
  correlationId: string;
  sessionId: string | null;
  client: TrafficClient;
  method: string | null;
  startedAt: number;
  requestBytes: number | null;
  // Transient request-local copy used only for token estimation. Traffic/Activity
  // serializers remain allowlist-only and never emit these raw arguments.
  rawToolArguments?: unknown;
  outcome: { failed: boolean; errorCode: McpTrafficErrorCode | null };
};

export const mcpRequestContext = new AsyncLocalStorage<McpRequestContextValue>();

let processSequence = 0;

function nextSequence(): number {
  processSequence += 1;
  return processSequence;
}

function boundedInt(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function boundedText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ");
  return trimmed ? trimmed.slice(0, maximum) : null;
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 128) || "unknown-mcp-client"
  );
}

export function normalizeMcpClient(input: { name?: unknown; version?: unknown } | null | undefined): TrafficClient {
  const rawName = boundedText(input?.name, 80) ?? "Unknown MCP Client";
  const key = rawName.toLowerCase();
  const known = key.includes("chatgpt") || key === "openai"
    ? { id: "chatgpt", label: "ChatGPT" }
    : key.includes("claude")
      ? { id: "claude", label: "Claude" }
      : key.includes("gemini")
        ? { id: "gemini", label: "Gemini" }
        : key.includes("codex")
          ? { id: "codex", label: "Codex" }
          : key.includes("inspector")
            ? { id: "mcp-inspector", label: "MCP Inspector" }
            : { id: slug(rawName), label: rawName };
  return {
    ...known,
    version: boundedText(input?.version, 64),
    session_name: null,
    model: null,
    workspace_id: null,
    workspace_name: null,
  };
}

export function enrichMcpClientSession(
  client: TrafficClient,
  input: {
    sessionId?: unknown;
    sessionName?: unknown;
    model?: unknown;
    workspaceId?: unknown;
    workspaceName?: unknown;
  },
): TrafficClient {
  if (client.id !== "chatgpt" && !client.id.startsWith("chatgpt-session-")) return client;
  const sessionId = boundedText(input.sessionId, 96);
  if (!sessionId) return client;
  const sessionName = boundedText(input.sessionName, 160) ?? client.session_name;
  const model = boundedText(input.model, 120) ?? client.model;
  const workspaceId = boundedText(input.workspaceId, 200) ?? client.workspace_id;
  const workspaceName = boundedText(input.workspaceName, 160) ?? client.workspace_name;
  const sessionSlug = slug(sessionId).slice(0, 96);
  const label = boundedText(sessionName ? `ChatGPT · ${sessionName}` : "ChatGPT", 80) ?? "ChatGPT";
  return {
    ...client,
    id: `chatgpt-session-${sessionSlug}`,
    label,
    session_name: sessionName,
    model,
    workspace_id: workspaceId,
    workspace_name: workspaceName,
  };
}

export function normalizeTrafficErrorCode(error: unknown): McpTrafficErrorCode {
  if (!error || typeof error !== "object") return "internal_error";
  const record = error as Record<string, unknown>;
  const status = typeof record.status === "number" ? record.status : Number(record.status);
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 400 || status === 409 || status === 422) return "validation_error";
  const name = String(record.name ?? "").toLowerCase();
  const code = String(record.code ?? "").toLowerCase();
  const kind = String(record.kind ?? "").toLowerCase();
  if (name.includes("timeout") || name.includes("abort") || code === "etimedout" || code === "timeout") {
    return "timeout";
  }
  if (kind === "tool_error" || code === "tool_error") return "tool_error";
  if (name === "computerapierror" || status >= 500) return "transport_error";
  return "internal_error";
}

function safeClient(client: TrafficClient): TrafficClient {
  return {
    id: (boundedText(client.id, 128) ?? "unknown-mcp-client").toLowerCase(),
    label: boundedText(client.label, 80) ?? "Unknown MCP Client",
    version: boundedText(client.version, 64),
    session_name: boundedText(client.session_name, 160),
    model: boundedText(client.model, 120),
    workspace_id: boundedText(client.workspace_id, 200),
    workspace_name: boundedText(client.workspace_name, 160),
  };
}

function nullableBoundedInt(value: number | null | undefined, maximum: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(maximum, Math.round(value)));
}

function copyEvent(event: McpTrafficEvent): McpTrafficEvent {
  return {
    version: 1,
    event_id: boundedText(event.event_id, 128) ?? randomUUID(),
    sequence: Math.max(1, Math.round(event.sequence)),
    event_type: event.event_type,
    timestamp_ms: Math.max(0, Math.round(event.timestamp_ms)),
    session_id: boundedText(event.session_id, 128),
    client: safeClient(event.client),
    request_id: boundedText(event.request_id, 128),
    correlation_id: boundedText(event.correlation_id, 128),
    method: boundedText(event.method, 128),
    tool_name: boundedText(event.tool_name, 256),
    status: event.status,
    duration_ms: nullableBoundedInt(event.duration_ms, 86_400_000),
    request_bytes: nullableBoundedInt(event.request_bytes, 100_000_000),
    response_bytes: nullableBoundedInt(event.response_bytes, 100_000_000),
    error_code: event.error_code,
  };
}

export type McpTrafficEmitterOptions = {
  deliver: (events: McpTrafficEvent[]) => Promise<void>;
  env?: Record<string, string | undefined>;
  onDeliveryFailure?: (error: unknown, events: readonly McpTrafficEvent[]) => void;
};

export class McpTrafficEmitter {
  private readonly deliver: (events: McpTrafficEvent[]) => Promise<void>;
  private readonly batchSize: number;
  private readonly flushMs: number;
  private readonly maxQueue: number;
  private readonly onDeliveryFailure?: (error: unknown, events: readonly McpTrafficEvent[]) => void;
  private queue: McpTrafficEvent[] = [];
  private dropped = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private deliveryPromise: Promise<void> | null = null;
  private closed = false;

  constructor(options: McpTrafficEmitterOptions) {
    const env = options.env ?? process.env;
    this.deliver = options.deliver;
    this.batchSize = boundedInt(env.CPTR_MCP_TRAFFIC_PLUGIN_BATCH_SIZE, 20, 1, 100);
    this.flushMs = boundedInt(env.CPTR_MCP_TRAFFIC_PLUGIN_FLUSH_MS, 250, 25, 10_000);
    this.maxQueue = boundedInt(env.CPTR_MCP_TRAFFIC_PLUGIN_MAX_QUEUE, 1000, 10, 10_000);
    this.onDeliveryFailure = options.onDeliveryFailure;
  }

  stats(): { queued: number; dropped: number; delivering: boolean } {
    return { queued: this.queue.length, dropped: this.dropped, delivering: this.deliveryPromise !== null };
  }

  sessionOpened(sessionId: string, client: TrafficClient): void {
    this.emit({
      event_type: "session_opened",
      session_id: sessionId,
      client,
      request_id: null,
      correlation_id: null,
      method: null,
      tool_name: null,
      status: "connected",
      duration_ms: null,
      request_bytes: null,
      response_bytes: null,
      error_code: null,
    });
  }

  sessionClosed(sessionId: string, client: TrafficClient): void {
    this.emit({
      event_type: "session_closed",
      session_id: sessionId,
      client,
      request_id: null,
      correlation_id: null,
      method: null,
      tool_name: null,
      status: "disconnected",
      duration_ms: null,
      request_bytes: null,
      response_bytes: null,
      error_code: null,
    });
  }

  requestStarted(input: {
    requestId?: string;
    correlationId?: string | null;
    sessionId: string | null;
    client: TrafficClient;
    method: string | null;
    requestBytes?: number | null;
  }): string {
    const requestId = boundedText(input.requestId, 128) ?? randomUUID();
    this.emit({
      event_type: "request_started",
      session_id: input.sessionId,
      client: input.client,
      request_id: requestId,
      correlation_id: input.correlationId ?? null,
      method: input.method,
      tool_name: null,
      status: "started",
      duration_ms: null,
      request_bytes: input.requestBytes ?? null,
      response_bytes: null,
      error_code: null,
    });
    return requestId;
  }

  requestFinished(input: McpRequestContextValue & { durationMs?: number | null; responseBytes?: number | null }): void {
    this.emit({
      event_type: "request_finished",
      session_id: input.sessionId,
      client: input.client,
      request_id: input.requestId,
      correlation_id: input.correlationId,
      method: input.method,
      tool_name: null,
      status: "complete",
      duration_ms: input.durationMs ?? Date.now() - input.startedAt,
      request_bytes: input.requestBytes,
      response_bytes: input.responseBytes ?? null,
      error_code: null,
    });
  }

  requestFailed(
    input: McpRequestContextValue & { durationMs?: number | null; responseBytes?: number | null },
    error: unknown,
  ): void {
    this.emit({
      event_type: "request_failed",
      session_id: input.sessionId,
      client: input.client,
      request_id: input.requestId,
      correlation_id: input.correlationId,
      method: input.method,
      tool_name: null,
      status: "error",
      duration_ms: input.durationMs ?? Date.now() - input.startedAt,
      request_bytes: input.requestBytes,
      response_bytes: input.responseBytes ?? null,
      error_code:
        input.outcome.failed && input.outcome.errorCode
          ? input.outcome.errorCode
          : normalizeTrafficErrorCode(error),
    });
  }

  toolStarted(toolName: string, context: McpRequestContextValue | undefined = mcpRequestContext.getStore()): void {
    if (!context) return;
    this.emitTool("tool_started", "started", toolName, context, null, null);
  }

  toolFinished(
    toolName: string,
    context: McpRequestContextValue | undefined = mcpRequestContext.getStore(),
    durationMs: number | null = null,
  ): void {
    if (!context) return;
    this.emitTool("tool_finished", "complete", toolName, context, durationMs, null);
  }

  toolFailed(
    toolName: string,
    error: unknown,
    context: McpRequestContextValue | undefined = mcpRequestContext.getStore(),
    durationMs: number | null = null,
  ): void {
    if (!context) return;
    this.emitTool("tool_failed", "error", toolName, context, durationMs, normalizeTrafficErrorCode(error));
  }

  async flush(): Promise<void> {
    if (this.deliveryPromise) return this.deliveryPromise;
    this.clearTimer();
    if (this.queue.length === 0) return;
    this.deliveryPromise = this.drain();
    try {
      await this.deliveryPromise;
    } finally {
      this.deliveryPromise = null;
      if (!this.closed && this.queue.length > 0) this.schedule();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.clearTimer();
    if (this.deliveryPromise) await this.deliveryPromise;
    if (this.queue.length > 0) {
      this.deliveryPromise = this.drain();
      try {
        await this.deliveryPromise;
      } finally {
        this.deliveryPromise = null;
      }
    }
  }

  private emitTool(
    eventType: "tool_started" | "tool_finished" | "tool_failed",
    status: "started" | "complete" | "error",
    toolName: string,
    context: McpRequestContextValue,
    durationMs: number | null,
    errorCode: McpTrafficErrorCode | null,
  ): void {
    this.emit({
      event_type: eventType,
      session_id: context.sessionId,
      client: context.client,
      request_id: context.requestId,
      correlation_id: context.correlationId,
      method: context.method,
      tool_name: toolName,
      status,
      duration_ms: durationMs,
      request_bytes: null,
      response_bytes: null,
      error_code: errorCode,
    });
  }

  private emit(input: Omit<McpTrafficEvent, "version" | "event_id" | "sequence" | "timestamp_ms">): void {
    if (this.closed) return;
    const event = copyEvent({
      version: 1,
      event_id: randomUUID(),
      sequence: nextSequence(),
      timestamp_ms: Date.now(),
      ...input,
    });
    if (this.queue.length >= this.maxQueue) {
      this.queue.shift();
      this.dropped += 1;
    }
    this.queue.push(event);
    this.schedule();
  }

  private schedule(): void {
    if (this.timer || this.deliveryPromise || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.flushMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.batchSize).map(copyEvent);
      try {
        await this.deliver(batch);
      } catch (error) {
        this.dropped += batch.length;
        try {
          this.onDeliveryFailure?.(error, batch);
        } catch {
          // Diagnostics callbacks are best-effort and must never affect MCP traffic.
        }
      }
    }
  }
}
