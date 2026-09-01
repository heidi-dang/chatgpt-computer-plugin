import { randomUUID } from "node:crypto";

export type McpLatencyEdge =
  | "client-mcp-connector"
  | "mcp-connector-cptr-mcp"
  | "cptr-mcp-cptr-backend";

export type McpLatencyMetric = "observed_request_time" | "adapter_handoff" | "backend_api_rtt";

export type McpFailureStage =
  | "client_transport"
  | "mcp_connector"
  | "cptr_mcp"
  | "cptr_backend"
  | "activity_delivery"
  | "traffic_delivery";

export type McpLatencyDiagnostic = {
  kind: "latency";
  version: 1;
  event_id: string;
  timestamp_ms: number;
  request_id: string | null;
  correlation_id: string | null;
  edge_id: McpLatencyEdge;
  metric_type: McpLatencyMetric;
  duration_ms: number;
  status: "ok" | "error";
};

export type McpUsageDiagnostic = {
  kind: "usage";
  version: 1;
  event_id: string;
  timestamp_ms: number;
  request_id: string | null;
  correlation_id: string | null;
  session_id: string | null;
  client_id: string;
  model_reported: string | null;
  model_canonical: string | null;
  model_source: "self_reported" | "unavailable";
  tool_name: string;
  input_tokens_estimated: number;
  output_tokens_estimated: number;
  cached_input_tokens_estimated: null;
  estimator_method: string;
  estimator_exact_for_model: boolean;
  status: "complete" | "error";
};

export type McpFailureDiagnostic = {
  kind: "failure";
  version: 1;
  diagnostic_id: string;
  request_id: string | null;
  correlation_id: string | null;
  session_id: string | null;
  client_id: string;
  method: string | null;
  tool_name: string | null;
  stage: McpFailureStage;
  error_code: string;
  http_status: number | null;
  retryable: boolean | null;
  started_at_ms: number | null;
  completed_at_ms: number;
  duration_ms: number | null;
  request_bytes: number | null;
  response_bytes: number | null;
  summary: string;
};

export type McpDiagnosticEvent = McpLatencyDiagnostic | McpFailureDiagnostic | McpUsageDiagnostic;

export type McpDiagnosticsEmitterOptions = {
  deliver: (events: McpDiagnosticEvent[]) => Promise<void>;
  env?: Record<string, string | undefined>;
  batchSize?: number;
  flushMs?: number;
  maxQueue?: number;
};

function boundedInt(raw: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function boundedOverride(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

function boundedText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ");
  return trimmed ? trimmed.slice(0, maximum) : null;
}

function boundedNumber(value: number | null | undefined, maximum: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(maximum, Math.round(value)));
}

function boundedHttpStatus(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return rounded >= 100 && rounded <= 599 ? rounded : null;
}

export function sanitizeDiagnosticSummary(value: unknown): string {
  const text = typeof value === "string" ? value : "MCP request failed.";
  const redacted = text
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/(?:^|[\s:(])\/(?:[^\s/:]+\/)*[^\s/:]+/g, (match) => {
      const prefix = /^[\s:(]/.test(match) ? match[0] : "";
      return `${prefix}<redacted-path>`;
    })
    .replace(/[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]+/g, "<redacted-path>")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (redacted || "MCP request failed.").slice(0, 500);
}

function copyLatency(event: McpLatencyDiagnostic): McpLatencyDiagnostic {
  return {
    kind: "latency",
    version: 1,
    event_id: boundedText(event.event_id, 128) ?? randomUUID(),
    timestamp_ms: boundedNumber(event.timestamp_ms, Number.MAX_SAFE_INTEGER) ?? Date.now(),
    request_id: boundedText(event.request_id, 128),
    correlation_id: boundedText(event.correlation_id, 128),
    edge_id: event.edge_id,
    metric_type: event.metric_type,
    duration_ms: boundedNumber(event.duration_ms, 86_400_000) ?? 0,
    status: event.status,
  };
}

function copyUsage(event: McpUsageDiagnostic): McpUsageDiagnostic {
  return {
    kind: "usage",
    version: 1,
    event_id: boundedText(event.event_id, 128) ?? randomUUID(),
    timestamp_ms: boundedNumber(event.timestamp_ms, Number.MAX_SAFE_INTEGER) ?? Date.now(),
    request_id: boundedText(event.request_id, 128),
    correlation_id: boundedText(event.correlation_id, 128),
    session_id: boundedText(event.session_id, 128),
    client_id: (boundedText(event.client_id, 128) ?? "chatgpt").toLowerCase(),
    model_reported: boundedText(event.model_reported, 120),
    model_canonical: boundedText(event.model_canonical, 64),
    model_source: event.model_source === "self_reported" ? "self_reported" : "unavailable",
    tool_name: boundedText(event.tool_name, 256) ?? "unknown-tool",
    input_tokens_estimated: boundedNumber(event.input_tokens_estimated, 100_000_000) ?? 0,
    output_tokens_estimated: boundedNumber(event.output_tokens_estimated, 100_000_000) ?? 0,
    cached_input_tokens_estimated: null,
    estimator_method: boundedText(event.estimator_method, 160) ?? "unknown",
    estimator_exact_for_model: event.estimator_exact_for_model === true,
    status: event.status === "error" ? "error" : "complete",
  };
}

function copyFailure(event: McpFailureDiagnostic): McpFailureDiagnostic {
  return {
    kind: "failure",
    version: 1,
    diagnostic_id: boundedText(event.diagnostic_id, 128) ?? randomUUID(),
    request_id: boundedText(event.request_id, 128),
    correlation_id: boundedText(event.correlation_id, 128),
    session_id: boundedText(event.session_id, 128),
    client_id: (boundedText(event.client_id, 128) ?? "chatgpt").toLowerCase(),
    method: boundedText(event.method, 128),
    tool_name: boundedText(event.tool_name, 256),
    stage: event.stage,
    error_code: boundedText(event.error_code, 64) ?? "unknown_error",
    http_status: boundedHttpStatus(event.http_status),
    retryable: typeof event.retryable === "boolean" ? event.retryable : null,
    started_at_ms: boundedNumber(event.started_at_ms, Number.MAX_SAFE_INTEGER),
    completed_at_ms: boundedNumber(event.completed_at_ms, Number.MAX_SAFE_INTEGER) ?? Date.now(),
    duration_ms: boundedNumber(event.duration_ms, 86_400_000),
    request_bytes: boundedNumber(event.request_bytes, 100_000_000),
    response_bytes: boundedNumber(event.response_bytes, 100_000_000),
    summary: sanitizeDiagnosticSummary(event.summary),
  };
}

function copyEvent(event: McpDiagnosticEvent): McpDiagnosticEvent {
  if (event.kind === "latency") return copyLatency(event);
  if (event.kind === "usage") return copyUsage(event);
  return copyFailure(event);
}

export class McpDiagnosticsEmitter {
  private readonly deliver: (events: McpDiagnosticEvent[]) => Promise<void>;
  private readonly batchSize: number;
  private readonly flushMs: number;
  private readonly maxQueue: number;
  private queue: McpDiagnosticEvent[] = [];
  private dropped = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private deliveryPromise: Promise<void> | null = null;
  private closed = false;

  constructor(options: McpDiagnosticsEmitterOptions) {
    const env = options.env ?? process.env;
    const envBatchSize = boundedInt(env.CPTR_MCP_DIAGNOSTICS_PLUGIN_BATCH_SIZE, 20, 1, 100);
    const envFlushMs = boundedInt(env.CPTR_MCP_DIAGNOSTICS_PLUGIN_FLUSH_MS, 250, 25, 10_000);
    const envMaxQueue = boundedInt(env.CPTR_MCP_DIAGNOSTICS_PLUGIN_MAX_QUEUE, 500, 10, 5_000);
    this.deliver = options.deliver;
    this.batchSize = boundedOverride(options.batchSize, envBatchSize, 1, 100);
    this.flushMs = boundedOverride(options.flushMs, envFlushMs, 1, 10_000);
    this.maxQueue = boundedOverride(options.maxQueue, envMaxQueue, 1, 5_000);
  }

  stats(): { queued: number; dropped: number; delivering: boolean } {
    return { queued: this.queue.length, dropped: this.dropped, delivering: this.deliveryPromise !== null };
  }

  latency(
    input: Omit<McpLatencyDiagnostic, "kind" | "version" | "event_id" | "timestamp_ms">,
  ): void {
    this.emit({
      kind: "latency",
      version: 1,
      event_id: randomUUID(),
      timestamp_ms: Date.now(),
      ...input,
    });
  }

  failure(
    input: Omit<McpFailureDiagnostic, "kind" | "version" | "diagnostic_id" | "completed_at_ms">,
  ): void {
    this.emit({
      kind: "failure",
      version: 1,
      diagnostic_id: randomUUID(),
      completed_at_ms: Date.now(),
      ...input,
    });
  }

  usage(
    input: Omit<McpUsageDiagnostic, "kind" | "version" | "event_id" | "timestamp_ms">,
  ): void {
    this.emit({
      kind: "usage",
      version: 1,
      event_id: randomUUID(),
      timestamp_ms: Date.now(),
      ...input,
    });
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

  private emit(event: McpDiagnosticEvent): void {
    if (this.closed) return;
    if (this.queue.length >= this.maxQueue) {
      this.queue.shift();
      this.dropped += 1;
    }
    this.queue.push(copyEvent(event));
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
      } catch {
        this.dropped += batch.length;
      }
    }
  }
}
