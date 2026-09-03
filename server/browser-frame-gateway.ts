import type { IncomingMessage, ServerResponse } from "node:http";
import type { ComputerClient } from "./client/computer-client.js";
import type { PromptTerminalStore } from "./prompt-terminal.js";

function bearerValue(request: IncomingMessage): string | null {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ")) return null;
  const token = value.slice("Bearer ".length).trim();
  return token || null;
}

function boundedId(value: string | null, max: number): string | null {
  if (!value || value.length > max || !/^[A-Za-z0-9_.:-]+$/.test(value)) return null;
  return value;
}

export class PromptBrowserFrameGateway {
  constructor(
    private readonly client: ComputerClient,
    private readonly promptSessions: PromptTerminalStore,
  ) {}

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const ticket = bearerValue(request);
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/live/prompt/browser-frame" || request.method !== "GET" || !ticket) {
      this.json(response, 404, { error: "browser frame not found" });
      return;
    }
    const sessionId = boundedId(url.searchParams.get("session_id"), 120);
    const afterFrameId = url.searchParams.get("after_frame_id");
    if (!sessionId || (afterFrameId && !boundedId(afterFrameId, 160))) {
      this.json(response, 400, { error: "invalid browser frame request" });
      return;
    }
    if (!this.promptSessions.allowsBrowserSession(ticket, sessionId)) {
      this.json(response, 403, { error: "browser session is not bound to this prompt" });
      return;
    }
    try {
      const upstream = await this.client.getUserChromeFrame(sessionId, afterFrameId ?? undefined);
      if (upstream.status === 204) {
        response.writeHead(204, { "cache-control": "no-store", "referrer-policy": "no-referrer" }).end();
        return;
      }
      const bytes = Buffer.from(await upstream.arrayBuffer());
      if (bytes.byteLength > 8 * 1024 * 1024) {
        this.json(response, 502, { error: "browser frame exceeds proxy limit" });
        return;
      }
      const mime = upstream.headers.get("content-type") ?? "image/jpeg";
      if (!new Set(["image/jpeg", "image/webp"]).has(mime)) {
        this.json(response, 502, { error: "browser frame type is unsupported" });
        return;
      }
      const headers: Record<string, string> = {
        "content-type": mime,
        "content-length": String(bytes.byteLength),
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      };
      for (const name of ["x-cptr-frame-id", "x-cptr-frame-width", "x-cptr-frame-height", "x-cptr-frame-time"]) {
        const value = upstream.headers.get(name);
        if (value) headers[name] = value;
      }
      response.writeHead(200, headers).end(bytes);
    } catch {
      this.json(response, 502, { error: "browser frame unavailable" });
    }
  }

  private json(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    }).end(JSON.stringify(value));
  }
}
