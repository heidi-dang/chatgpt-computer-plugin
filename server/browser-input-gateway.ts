import type { IncomingMessage, ServerResponse } from "node:http";
import type { ComputerClient } from "./client/computer-client.js";
import type { PromptTerminalStore } from "./prompt-terminal.js";

const MAX_BODY_BYTES = 24_000;
const ALLOWED_INPUT_TYPES = new Set([
  "pointer_move", "pointer_down", "pointer_up", "click", "double_click", "wheel",
  "key_down", "key_up", "text_input", "touch_start", "touch_move", "touch_end",
  "focus", "blur", "viewport_resize", "drag_start", "drag_move", "drag_end",
]);

function bearerValue(request: IncomingMessage): string | null {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ")) return null;
  const token = value.slice("Bearer ".length).trim();
  return token || null;
}

function boundedId(value: unknown, max: number): string | null {
  if (typeof value !== "string" || !value || value.length > max || !/^[A-Za-z0-9_.:-]+$/.test(value)) return null;
  return value;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > MAX_BODY_BYTES) return null;
    chunks.push(value);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function validNumber(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

export class PromptBrowserInputGateway {
  constructor(
    private readonly client: ComputerClient,
    private readonly promptSessions: PromptTerminalStore,
  ) {}

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const ticket = bearerValue(request);
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/live/prompt/browser-input" || request.method !== "POST" || !ticket) {
      this.json(response, 404, { error: "browser input not found" });
      return;
    }
    const body = await readJson(request);
    if (!body) {
      this.json(response, 400, { error: "invalid browser input request" });
      return;
    }
    const sessionId = boundedId(body.session_id, 120);
    const commandId = boundedId(body.command_id, 160);
    const inputType = typeof body.input_type === "string" ? body.input_type : "";
    const expectedEpoch = body.expected_epoch;
    if (!sessionId || !commandId || !ALLOWED_INPUT_TYPES.has(inputType) || !Number.isSafeInteger(expectedEpoch) || Number(expectedEpoch) < 0) {
      this.json(response, 400, { error: "invalid browser input request" });
      return;
    }
    if (!this.promptSessions.allowsBrowserSession(ticket, sessionId)) {
      this.json(response, 403, { error: "browser session is not bound to this prompt" });
      return;
    }
    if ((body.x !== undefined && !validNumber(body.x, 0, 1)) || (body.y !== undefined && !validNumber(body.y, 0, 1))) {
      this.json(response, 400, { error: "invalid normalized coordinates" });
      return;
    }
    if (typeof body.text === "string" && body.text.length > 20_000) {
      this.json(response, 400, { error: "browser text input is too large" });
      return;
    }
    const forwarded: Record<string, unknown> = { ...body };
    delete forwarded.session_id;
    try {
      const result = await this.client.sendUserChromeHumanInput(sessionId, forwarded);
      this.json(response, 200, result);
    } catch {
      this.json(response, 502, { error: "browser input unavailable" });
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
