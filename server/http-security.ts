type Environment = Record<string, string | undefined>;

function normalizedOrigin(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`${name} must be an absolute URL origin`);
  }
  if (!/^https?:$/.test(url.protocol) || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${name} must be an http(s) origin without a path, query, or fragment`);
  }
  return url.origin;
}

export function resolvePublicOrigin(env: Environment, host: string, port: number): string {
  const configured = env.PUBLIC_ORIGIN?.trim();
  if (configured) {
    const origin = normalizedOrigin(configured, "PUBLIC_ORIGIN");
    if (env.NODE_ENV === "production") {
      const url = new URL(origin);
      const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
      if (url.protocol !== "https:") throw new Error("PUBLIC_ORIGIN must use HTTPS in production");
      if (hostname === "localhost" || hostname === "::1" || hostname === "127.0.0.1" || hostname.startsWith("127.")) {
        throw new Error("PUBLIC_ORIGIN cannot be localhost in production");
      }
    }
    return origin;
  }
  if (env.NODE_ENV === "production") {
    throw new Error("PUBLIC_ORIGIN is required when NODE_ENV=production");
  }
  return normalizedOrigin(`http://${host}:${port}`, "local PUBLIC_ORIGIN");
}

export function resolveAllowedOrigins(env: Environment): Set<string> {
  const configured = (env.MCP_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => normalizedOrigin(value, "MCP_ALLOWED_ORIGINS"));
  if (env.NODE_ENV === "production" && configured.length === 0) {
    throw new Error("MCP_ALLOWED_ORIGINS is required when NODE_ENV=production");
  }
  return new Set(configured);
}

export function isAllowedBrowserOrigin(origin: string | undefined, allowedOrigins: Set<string>): boolean {
  // Requests made by non-browser MCP clients do not set Origin. Browser requests
  // to the MCP transport itself must match the explicit allowlist.
  return !origin || allowedOrigins.has(origin);
}

function isOpenAiWidgetOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    const hostname = url.hostname.toLowerCase();
    return hostname === "web-sandbox.oaiusercontent.com" || hostname.endsWith(".web-sandbox.oaiusercontent.com");
  } catch {
    return false;
  }
}

export function isAllowedWorkbenchBrowserOrigin(origin: string | undefined, allowedOrigins: Set<string>): boolean {
  // Apps SDK widgets execute from a ChatGPT-owned sandbox origin rather than
  // PUBLIC_ORIGIN. Live endpoints remain protected by opaque, target-bound
  // bearer tickets, so permit only the explicit allowlist plus the documented
  // OpenAI widget sandbox family here; do not widen the MCP transport policy.
  return !origin || allowedOrigins.has(origin) || isOpenAiWidgetOrigin(origin);
}

export function corsHeaders(origin: string | undefined, allowedOrigins: Set<string>): Record<string, string> {
  if (!origin || !allowedOrigins.has(origin)) return {};
  return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
}

export function workbenchCorsHeaders(origin: string | undefined, allowedOrigins: Set<string>): Record<string, string> {
  if (!origin || !isAllowedWorkbenchBrowserOrigin(origin, allowedOrigins)) return {};
  return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
}
