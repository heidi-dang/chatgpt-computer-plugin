import type { ServerResponse, IncomingMessage } from "node:http";
import type { ComputerClient } from "./client/computer-client.js";
import { LiveTicketStore } from "./live-tickets.js";
import { LiveViewerRegistry, liveViewerIdentity } from "./live-viewers.js";

function bearerValue(request: IncomingMessage): string | null {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ")) return null;
  const token = value.slice("Bearer ".length).trim();
  return token || null;
}

async function waitForDrain(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  if (request.destroyed || response.destroyed) return false;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (drained: boolean) => {
      if (settled) return;
      settled = true;
      response.removeListener("drain", onDrain);
      request.removeListener("close", onClose);
      response.removeListener("close", onClose);
      resolve(drained);
    };
    const onDrain = () => finish(true);
    const onClose = () => finish(false);
    response.once("drain", onDrain);
    request.once("close", onClose);
    response.once("close", onClose);
    if (request.destroyed || response.destroyed) finish(false);
  });
}

export class LiveGateway {
  private activeStreams = 0;
  private readonly viewers = new LiveViewerRegistry();

  constructor(
    private readonly client: ComputerClient,
    private readonly tickets: LiveTicketStore,
    private readonly limits: { maxConcurrent?: number; maxBytes?: number; maxDurationMs?: number } = {},
  ) {}

  async handleRenew(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const ticket = bearerValue(request);
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/live/renew" || request.method !== "POST" || !ticket) {
      response.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: "live renewal not found" }));
      return;
    }
    const renewed = this.tickets.renew(ticket);
    if (!renewed) {
      response.writeHead(401, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "www-authenticate": "Bearer",
      });
      response.end(JSON.stringify({ error: "live renewal ticket is invalid or outside the renewal window" }));
      return;
    }
    response.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    });
    response.end(JSON.stringify(renewed));
  }

  async handleSnapshot(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const ticket = bearerValue(request);
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/live/snapshot" || !ticket) {
      response.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: "live snapshot not found" }));
      return;
    }
    const claims = this.tickets.validate(ticket);
    const rawAfter = url.searchParams.get("after") ?? "0";
    if (!claims) {
      if (!/^\d{1,12}$/.test(rawAfter)) {
        response.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: "invalid live-event cursor" }));
        return;
      }
      if (!ticket.startsWith("v1.")) {
        response.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
          "x-cptr-stream-state": "legacy-retired",
        });
        response.end(JSON.stringify({
          snapshot: { status: "BLOCKED" },
          replay: { events: [], last_sequence: Number(rawAfter) },
        }));
        return;
      }
      response.writeHead(401, { "content-type": "application/json", "cache-control": "no-store", "www-authenticate": "Bearer" });
      response.end(JSON.stringify({ error: "live snapshot ticket is invalid or expired" }));
      return;
    }
    if (!/^\d{1,12}$/.test(rawAfter)) {
      response.writeHead(400, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: "invalid live-event cursor" }));
      return;
    }
    try {
      const snapshot = claims.targetType === "command"
        ? await this.client.getLiveSnapshot(
            "command",
            claims.targetId,
            Number(rawAfter),
            claims.workspaceId,
            claims.workerId,
          )
        : await this.client.getLiveSnapshot(claims.targetType, claims.targetId, Number(rawAfter));
      response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      });
      response.end(JSON.stringify(snapshot));
    } catch {
      response.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: "live snapshot unavailable" }));
    }
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const ticket = bearerValue(request);
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path !== "/live/stream" || !ticket) {
      response.writeHead(404, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify({ error: "live stream not found" }));
      return;
    }
    const maxConcurrent = this.limits.maxConcurrent ?? 8;
    if (this.activeStreams >= maxConcurrent) {
      response.writeHead(429, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify({ error: "live stream capacity reached" }));
      return;
    }

    const claims = this.tickets.validate(ticket);
    if (!claims) {
      response.writeHead(401, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "www-authenticate": "Bearer",
      });
      response.end(JSON.stringify({ error: "live stream ticket is invalid or expired" }));
      return;
    }

    const streamScope = this.tickets.sessionIdentity(ticket);
    const viewer = liveViewerIdentity(request);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let superseded = false;
    const closeViewer = () => {
      superseded = true;
      void reader?.cancel().catch(() => undefined);
      if (!response.writableEnded) response.end();
    };
    if (streamScope && this.viewers.claim(streamScope, viewer, closeViewer) === "superseded") {
      response.writeHead(409, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "x-cptr-stream-state": "superseded",
      });
      response.end(JSON.stringify({ error: "live viewer was superseded by a newer Workbench" }));
      return;
    }
    const releaseViewer = () => {
      if (streamScope) this.viewers.release(streamScope, viewer);
    };

    this.activeStreams += 1;
    const lastEventId = request.headers["last-event-id"];
    if (typeof lastEventId === "string" && !/^\d{1,12}$/.test(lastEventId)) {
      this.activeStreams -= 1;
      releaseViewer();
      response.writeHead(400, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify({ error: "invalid live-event cursor" }));
      return;
    }
    const afterSequence = typeof lastEventId === "string" ? Number(lastEventId) : 0;
    let upstream: Response;
    try {
      upstream = claims.targetType === "command"
        ? await this.client.streamLive(
            "command",
            claims.targetId,
            afterSequence,
            claims.workspaceId,
            claims.workerId,
          )
        : await this.client.streamLive(claims.targetType, claims.targetId, afterSequence);
    } catch {
      this.activeStreams -= 1;
      releaseViewer();
      response.writeHead(502, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify({ error: "live stream unavailable" }));
      return;
    }
    if (!upstream.ok || !upstream.body) {
      this.activeStreams -= 1;
      releaseViewer();
      response.writeHead(upstream.status >= 400 ? upstream.status : 502, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify({ error: "live stream unavailable" }));
      return;
    }

    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-store",
      "referrer-policy": "no-referrer",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    reader = upstream.body.getReader();
    if (superseded) {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
      this.activeStreams -= 1;
      releaseViewer();
      return;
    }
    request.on("close", () => void reader?.cancel());
    const maxBytes = this.limits.maxBytes ?? 1_048_576;
    const deadline = Date.now() + (this.limits.maxDurationMs ?? 10 * 60_000);
    let bytes = 0;
    try {
      while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const next = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("live stream duration limit reached")), remaining);
          }),
        ]).finally(() => {
          if (timer) clearTimeout(timer);
        });
        if (next.done) break;
        const chunk = Buffer.from(next.value);
        bytes += chunk.byteLength;
        if (bytes > maxBytes) break;
        const writable = response.write(chunk);
        if (!writable && typeof response.once === "function") {
          if (!(await waitForDrain(request, response))) break;
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
      this.activeStreams -= 1;
      releaseViewer();
      response.end();
    }
  }
}
