const endpointValue = process.env.CPTR_DEPLOYED_MCP_URL?.trim();
const originValue = process.env.CPTR_DEPLOYED_PUBLIC_ORIGIN?.trim();
if (!endpointValue && !originValue) {
  throw new Error("Set CPTR_DEPLOYED_MCP_URL or CPTR_DEPLOYED_PUBLIC_ORIGIN before running the public-edge check.");
}

const endpoint = endpointValue ? new URL(endpointValue) : new URL("/mcp", originValue);
const origin = originValue ? new URL(originValue).origin : endpoint.origin;
if (endpoint.pathname !== "/mcp") throw new Error(`expected MCP endpoint path /mcp, got ${endpoint.pathname}`);
const timeoutMs = Number.parseInt(process.env.CPTR_EDGE_TIMEOUT_MS ?? "10000", 10);

async function request(path, init = {}) {
  const response = await fetch(new URL(path, origin), {
    redirect: "manual",
    signal: AbortSignal.timeout(Number.isFinite(timeoutMs) ? timeoutMs : 10_000),
    ...init,
  });
  return response;
}

async function jsonResponse(response, label, expectedStatus) {
  const contentType = response.headers.get("content-type") ?? "";
  if (response.status !== expectedStatus) {
    const sample = (await response.text()).slice(0, 240).replace(/\s+/g, " ");
    throw new Error(`${label} returned HTTP ${response.status}, expected ${expectedStatus}; body=${sample || "<empty>"}`);
  }
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error(`${label} returned unexpected content-type ${contentType || "<missing>"}; possible proxy/WAF interstitial`);
  }
  return await response.json();
}

const health = await jsonResponse(await request("/health"), "health", 200);
if (health?.status !== "ok" || health?.workbench?.ready !== true) {
  throw new Error("health reports a degraded production Workbench");
}

const protectedResource = await jsonResponse(
  await request("/.well-known/oauth-protected-resource/mcp"),
  "RFC 9728 protected-resource metadata",
  200,
);
if (protectedResource?.resource !== new URL("/mcp", origin).href) {
  throw new Error(`protected-resource metadata advertises ${protectedResource?.resource ?? "<missing>"} instead of ${new URL("/mcp", origin).href}`);
}
if (!Array.isArray(protectedResource?.authorization_servers) || protectedResource.authorization_servers.length === 0) {
  throw new Error("protected-resource metadata does not advertise an authorization server");
}

const authorizationMetadata = await jsonResponse(
  await request("/.well-known/oauth-authorization-server"),
  "OAuth authorization-server metadata",
  200,
);
for (const key of ["authorization_endpoint", "token_endpoint", "registration_endpoint"]) {
  const value = authorizationMetadata?.[key];
  if (typeof value !== "string" || new URL(value).origin !== origin) {
    throw new Error(`authorization metadata ${key} must be a same-origin absolute URL`);
  }
}
if (authorizationMetadata?.client_id_metadata_document_supported !== true) {
  throw new Error("authorization metadata does not advertise CIMD support");
}
if (!authorizationMetadata?.code_challenge_methods_supported?.includes?.("S256")) {
  throw new Error("authorization metadata does not advertise PKCE S256");
}
if (!authorizationMetadata?.grant_types_supported?.includes?.("refresh_token")) {
  throw new Error("authorization metadata does not advertise refresh-token support");
}

const registration = await jsonResponse(
  await request("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "CPTR edge qualification",
      redirect_uris: ["http://127.0.0.1:43123/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
    }),
  }),
  "OAuth DCR edge qualification",
  201,
);
if (registration?.application_type !== "native" || typeof registration?.client_id !== "string") {
  throw new Error("OAuth DCR edge qualification returned an invalid registration");
}

const invalidToken = await jsonResponse(
  await request("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: "edge-canary-invalid-client",
      refresh_token: "edge-canary-invalid-refresh-token",
      resource: new URL("/mcp", origin).href,
    }),
  }),
  "OAuth token edge qualification",
  400,
);
if (invalidToken?.error !== "invalid_grant") {
  throw new Error(`OAuth token edge qualification returned unexpected error ${invalidToken?.error ?? "<missing>"}`);
}

const discoverChallenge = await request("/mcp", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2026-07-28",
    "Mcp-Method": "server/discover",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: "edge-canary",
    method: "server/discover",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "cptr-edge-canary", version: "1.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  }),
});
if (discoverChallenge.status !== 401) {
  const sample = (await discoverChallenge.text()).slice(0, 240).replace(/\s+/g, " ");
  throw new Error(`unauthenticated MCP 2026 discovery returned HTTP ${discoverChallenge.status}, expected 401; body=${sample || "<empty>"}`);
}
const challenge = discoverChallenge.headers.get("www-authenticate") ?? "";
const advertisedResourceMetadata = challenge.match(/resource_metadata="([^"]+)"/)?.[1] ?? null;
if (!challenge.includes("resource_metadata=") || !challenge.includes("/.well-known/oauth-protected-resource/mcp")) {
  throw new Error(
    `MCP 401 challenge does not point to canonical RFC 9728 protected-resource metadata; got ${advertisedResourceMetadata ?? "<missing>"}. ` +
    "If the URL is under /.well-known/cloudflare-access-protected-resource/, Cloudflare Access Managed OAuth is intercepting /mcp and must be disabled for that route.",
  );
}

console.log(`CPTR public edge verified at ${origin}: health, RFC 9728, OAuth metadata, DCR, token POST/WAF path, and MCP 2026 auth challenge.`);
