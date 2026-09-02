import { randomUUID } from "node:crypto";
import type { TrafficClient } from "./mcp-traffic.js";

export type McpActivityPhase = "started" | "complete" | "failed";
export type McpActivityClient = Pick<TrafficClient, "id" | "label" | "version">;

export type McpActivityEvent = {
  version: 1;
  event_id: string;
  sequence: number;
  timestamp_ms: number;
  client: McpActivityClient;
  session_id: string | null;
  request_id: string | null;
  correlation_id: string | null;
  tool_name: string;
  title: string | null;
  phase: McpActivityPhase;
  summary: string;
  arguments_json: string | null;
  result_json: string | null;
  error_json: string | null;
  duration_ms: number | null;
};

export type McpActivityBaseInput = {
  client: TrafficClient;
  sessionId?: string | null;
  requestId?: string | null;
  correlationId?: string | null;
  toolName: string;
  title?: string | null;
  summary: string;
};

export type McpActivityStartedInput = McpActivityBaseInput & {
  argumentsJson?: string | null;
};

export type McpActivityCompleteInput = McpActivityBaseInput & {
  resultJson?: string | null;
  durationMs?: number | null;
};

export type McpActivityFailedInput = McpActivityBaseInput & {
  errorJson?: string | null;
  durationMs?: number | null;
};

export type McpActivityEmitterOptions = {
  deliver: (events: McpActivityEvent[]) => Promise<void>;
  env?: Record<string, string | undefined>;
  /** Explicit bounded overrides are intended for deterministic unit tests. */
  batchSize?: number;
  flushMs?: number;
  maxQueue?: number;
  onDeliveryFailure?: (error: unknown, events: readonly McpActivityEvent[]) => void;
};

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

function boundedOverride(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

function boundedText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ");
  return trimmed ? trimmed.slice(0, maximum) : null;
}

function boundedPayload(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 13_000) : null;
}

function safeClient(client: TrafficClient | McpActivityClient): McpActivityClient {
  return {
    id: (boundedText(client.id, 128) ?? "unknown-mcp-client").toLowerCase(),
    label: boundedText(client.label, 80) ?? "Unknown MCP Client",
    version: boundedText(client.version, 64),
  };
}

function boundedDuration(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(86_400_000, Math.round(value)));
}

function copyEvent(event: McpActivityEvent): McpActivityEvent {
  return {
    version: 1,
    event_id: boundedText(event.event_id, 128) ?? randomUUID(),
    sequence: Math.max(1, Math.round(event.sequence)),
    timestamp_ms: Math.max(0, Math.round(event.timestamp_ms)),
    client: safeClient(event.client),
    session_id: boundedText(event.session_id, 128),
    request_id: boundedText(event.request_id, 128),
    correlation_id: boundedText(event.correlation_id, 128),
    tool_name: boundedText(event.tool_name, 256) ?? "unknown-tool",
    title: boundedText(event.title, 160),
    phase: event.phase,
    summary: boundedText(event.summary, 500) ?? "MCP tool activity",
    arguments_json: boundedPayload(event.arguments_json),
    result_json: boundedPayload(event.result_json),
    error_json: boundedPayload(event.error_json),
    duration_ms: boundedDuration(event.duration_ms),
  };
}

export class McpActivityEmitter {
  private readonly deliver: (events: McpActivityEvent[]) => Promise<void>;
  private readonly batchSize: number;
  private readonly flushMs: number;
  private readonly maxQueue: number;
  private readonly onDeliveryFailure?: (error: unknown, events: readonly McpActivityEvent[]) => void;
  private queue: McpActivityEvent[] = [];
  private dropped = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private deliveryPromise: Promise<void> | null = null;
  private closed = false;

  constructor(options: McpActivityEmitterOptions) {
    const env = options.env ?? process.env;
    const envBatchSize = boundedInt(env.CPTR_MCP_ACTIVITY_PLUGIN_BATCH_SIZE, 20, 1, 100);
    const envFlushMs = boundedInt(env.CPTR_MCP_ACTIVITY_PLUGIN_FLUSH_MS, 250, 25, 10_000);
    const envMaxQueue = boundedInt(env.CPTR_MCP_ACTIVITY_PLUGIN_MAX_QUEUE, 500, 10, 5_000);
    this.deliver = options.deliver;
    this.batchSize = boundedOverride(options.batchSize, envBatchSize, 1, 100);
    this.flushMs = boundedOverride(options.flushMs, envFlushMs, 1, 10_000);
    this.maxQueue = boundedOverride(options.maxQueue, envMaxQueue, 1, 5_000);
    this.onDeliveryFailure = options.onDeliveryFailure;
  }

  stats(): { queued: number; dropped: number; delivering: boolean } {
    return { queued: this.queue.length, dropped: this.dropped, delivering: this.deliveryPromise !== null };
  }

  started(input: McpActivityStartedInput): void {
    this.emit({
      ...this.baseEvent(input),
      phase: "started",
      arguments_json: boundedPayload(input.argumentsJson),
      result_json: null,
      error_json: null,
      duration_ms: null,
    });
  }

  complete(input: McpActivityCompleteInput): void {
    this.emit({
      ...this.baseEvent(input),
      phase: "complete",
      arguments_json: null,
      result_json: boundedPayload(input.resultJson),
      error_json: null,
      duration_ms: boundedDuration(input.durationMs),
    });
  }

  failed(input: McpActivityFailedInput): void {
    this.emit({
      ...this.baseEvent(input),
      phase: "failed",
      arguments_json: null,
      result_json: null,
      error_json: boundedPayload(input.errorJson),
      duration_ms: boundedDuration(input.durationMs),
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

  private baseEvent(input: McpActivityBaseInput): Omit<McpActivityEvent, "phase" | "arguments_json" | "result_json" | "error_json" | "duration_ms"> {
    return {
      version: 1,
      event_id: randomUUID(),
      sequence: nextSequence(),
      timestamp_ms: Date.now(),
      client: safeClient(input.client),
      session_id: boundedText(input.sessionId, 128),
      request_id: boundedText(input.requestId, 128),
      correlation_id: boundedText(input.correlationId, 128),
      tool_name: boundedText(input.toolName, 256) ?? "unknown-tool",
      title: boundedText(input.title, 160),
      summary: boundedText(input.summary, 500) ?? "MCP tool activity",
    };
  }

  private emit(event: McpActivityEvent): void {
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
      } catch (error) {
        this.dropped += batch.length;
        try {
          this.onDeliveryFailure?.(error, batch);
        } catch {
          // Diagnostics callbacks are best-effort and must never affect MCP activity.
        }
      }
    }
  }
}
