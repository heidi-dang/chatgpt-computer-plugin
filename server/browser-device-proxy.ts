import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";

export const BROWSER_DEVICE_PREFIX = "/api/browser-device/v1";

const blockedRequestHeaders = new Set([
  "authorization",
  "cookie",
  "cf-access-jwt-assertion",
  "cf-authorization-token",
  "proxy-authorization",
]);
const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function targetFor(baseUrl: string, requestUrl: string | undefined): URL {
  const base = new URL(baseUrl);
  if (!/^https?:$/.test(base.protocol) || base.username || base.password) {
    throw new Error("CPTR_BASE_URL must be an http(s) origin for browser-device proxying");
  }
  const target = new URL(requestUrl ?? BROWSER_DEVICE_PREFIX, base);
  if (!isBrowserDevicePath(target.pathname)) throw new Error("browser-device proxy path escaped its allowed prefix");
  return target;
}

function requestHeaders(headers: IncomingHttpHeaders, target: URL, websocket: boolean): IncomingHttpHeaders {
  const forwarded: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (value === undefined || lower === "host" || blockedRequestHeaders.has(lower)) continue;
    if (!websocket && hopByHopHeaders.has(lower)) continue;
    forwarded[name] = value;
  }
  forwarded.host = target.host;
  return forwarded;
}

function responseHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const forwarded: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (
      value === undefined ||
      hopByHopHeaders.has(lower) ||
      lower === "set-cookie" ||
      lower.startsWith("access-control-")
    ) continue;
    forwarded[name] = value;
  }
  return forwarded;
}

function rawUpgradeResponse(statusCode: number, statusMessage: string | undefined, rawHeaders: string[]): string {
  let response = `HTTP/1.1 ${statusCode} ${statusMessage ?? "Switching Protocols"}\r\n`;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (!name || value === undefined) continue;
    const lower = name.toLowerCase();
    if (lower === "set-cookie" || lower.startsWith("access-control-")) continue;
    response += `${name}: ${value}\r\n`;
  }
  return `${response}\r\n`;
}

function writeSocketError(socket: Duplex, statusCode: number, message: string): void {
  if (socket.destroyed) return;
  const body = JSON.stringify({ error: message });
  socket.end(
    `HTTP/1.1 ${statusCode} ${statusCode === 403 ? "Forbidden" : "Bad Gateway"}\r\n` +
    "Content-Type: application/json\r\n" +
    "Cache-Control: no-store\r\n" +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    "Connection: close\r\n\r\n" +
    body,
  );
}

export function isBrowserDevicePath(pathname: string): boolean {
  return pathname === BROWSER_DEVICE_PREFIX || pathname.startsWith(`${BROWSER_DEVICE_PREFIX}/`);
}

export async function proxyBrowserDeviceHttp(
  req: IncomingMessage,
  res: ServerResponse,
  baseUrl: string,
): Promise<void> {
  let target: URL;
  try {
    target = targetFor(baseUrl, req.url);
  } catch {
    res.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" })
      .end(JSON.stringify({ error: "browser-device upstream is unavailable" }));
    return;
  }

  const requestImpl = target.protocol === "https:" ? httpsRequest : httpRequest;
  await new Promise<void>((resolve) => {
    const upstream = requestImpl(target, {
      method: req.method,
      headers: requestHeaders(req.headers, target, false),
    }, (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders(upstreamResponse.headers));
      upstreamResponse.pipe(res);
      upstreamResponse.once("end", resolve);
      upstreamResponse.once("error", () => {
        if (!res.writableEnded) res.end();
        resolve();
      });
    });
    upstream.once("error", () => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
      }
      if (!res.writableEnded) res.end(JSON.stringify({ error: "browser-device upstream is unavailable" }));
      resolve();
    });
    req.once("aborted", () => upstream.destroy());
    req.pipe(upstream);
  });
}

export function proxyBrowserDeviceUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  baseUrl: string,
): void {
  let target: URL;
  try {
    target = targetFor(baseUrl, req.url);
  } catch {
    writeSocketError(socket, 502, "browser-device upstream is unavailable");
    return;
  }

  const requestImpl = target.protocol === "https:" ? httpsRequest : httpRequest;
  const upstream = requestImpl(target, {
    method: req.method ?? "GET",
    headers: requestHeaders(req.headers, target, true),
  });

  upstream.once("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
    if (socket.destroyed) {
      upstreamSocket.destroy();
      return;
    }
    socket.write(rawUpgradeResponse(
      upstreamResponse.statusCode ?? 101,
      upstreamResponse.statusMessage,
      upstreamResponse.rawHeaders,
    ));
    if (upstreamHead.length > 0) socket.write(upstreamHead);
    if (head.length > 0) upstreamSocket.write(head);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
    const closePeer = () => {
      if (!socket.destroyed) socket.destroy();
      if (!upstreamSocket.destroyed) upstreamSocket.destroy();
    };
    socket.once("error", closePeer);
    upstreamSocket.once("error", closePeer);
    socket.once("close", closePeer);
    upstreamSocket.once("close", closePeer);
  });

  upstream.once("response", (upstreamResponse) => {
    if (socket.destroyed) return;
    socket.write(rawUpgradeResponse(
      upstreamResponse.statusCode ?? 502,
      upstreamResponse.statusMessage,
      upstreamResponse.rawHeaders,
    ));
    upstreamResponse.pipe(socket);
    upstreamResponse.once("end", () => socket.end());
  });
  upstream.once("error", () => writeSocketError(socket, 502, "browser-device upstream is unavailable"));
  upstream.end();
}

export function rejectBrowserDeviceUpgrade(socket: Duplex): void {
  writeSocketError(socket, 403, "browser origin is not allowed");
}
