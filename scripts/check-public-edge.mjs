import { createHash } from "node:crypto";

const endpointValue = process.env.CPTR_DEPLOYED_MCP_URL?.trim();
const originValue = process.env.CPTR_DEPLOYED_PUBLIC_ORIGIN?.trim();
if (!endpointValue && !originValue) {
  throw new Error("Set CPTR_DEPLOYED_MCP_URL or CPTR_DEPLOYED_PUBLIC_ORIGIN before running the public-edge check.");
}

const endpoint = endpointValue ? new URL(endpointValue) : new URL("/mcp", originValue);
const origin = originValue ? new URL(originValue).origin : endpoint.origin;
if (endpoint.pathname !== "/mcp") throw new Error(`expected MCP endpoint path /mcp, got ${endpoint.pathname}`);
if (endpoint.protocol !== "https:") throw new Error(`public MCP endpoint must use HTTPS, got ${endpoint.protocol}`);

const configuredAuthMode = process.env.CPTR_EDGE_AUTH_MODE?.trim().toLowerCase() || "auto";
const supportedAuthModes = new Set(["auto", "native", "cloudflare-managed"]);
if (!supportedAuthModes.has(configuredAuthMode)) {
  throw new Error(`CPTR_EDGE_AUTH_MODE must be one of ${[...supportedAuthModes].join(", ")}; got ${configuredAuthMode}`);
}

const requiredRedirectUris = (process.env.CPTR_EDGE_DCR_REDIRECT_URIS?.trim() || "http://localhost:7777/oauth/callback")
  .split(/[\n,]+/)
  .map((value) => value.trim())
  .filter(Boolean);
if (requiredRedirectUris.length === 0) {
  throw new Error("CPTR_EDGE_DCR_REDIRECT_URIS must contain at least one redirect URI");
}

const timeoutMs = Number.parseInt(process.env.CPTR_EDGE_TIMEOUT_MS ?? "10000", 10);
const effectiveTimeoutMs = Number.isFinite(timeoutMs) ? timeoutMs : 10_000;

async function fetchUrl(url, init = {}) {
  return await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(effectiveTimeoutMs),
    ...init,
  });
}

async function request(path, init = {}) {
  return await fetchUrl(new URL(path, origin), init);
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

function inferAuthMode(metadataUrl) {
  if (metadataUrl.pathname === "/.well-known/oauth-protected-resource/mcp") return "native";
  if (metadataUrl.pathname === "/.well-known/cloudflare-access-protected-resource/mcp") return "cloudflare-managed";
  throw new Error(`MCP 401 challenge points to unsupported RFC 9728 metadata: ${metadataUrl.href}`);
}

function requireHttpsAbsoluteUrl(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is missing`);
  const parsed = new URL(value);
  if (parsed.protocol !== "https:") throw new Error(`${label} must use HTTPS; got ${parsed.href}`);
  return parsed;
}

function normalizeIssuer(value) {
  return value.replace(/\/$/, "");
}

const health = await jsonResponse(await request("/health"), "health", 200);
if (health?.status !== "ok" || health?.workbench?.ready !== true) {
  throw new Error("health reports a degraded production Workbench");
}

const discoverChallenge = await request(endpoint.pathname, {
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
if (!advertisedResourceMetadata) {
  throw new Error(`MCP 401 challenge does not advertise RFC 9728 resource_metadata; header=${challenge || "<missing>"}`);
}
const resourceMetadataUrl = requireHttpsAbsoluteUrl(advertisedResourceMetadata, "MCP resource_metadata URL");
const inferredAuthMode = inferAuthMode(resourceMetadataUrl);
const authMode = configuredAuthMode === "auto" ? inferredAuthMode : configuredAuthMode;
if (authMode !== inferredAuthMode) {
  throw new Error(`configured edge auth mode ${configuredAuthMode} does not match live MCP challenge mode ${inferredAuthMode}`);
}

const protectedResource = await jsonResponse(
  await fetchUrl(resourceMetadataUrl),
  `RFC 9728 protected-resource metadata (${authMode})`,
  200,
);
if (protectedResource?.resource !== endpoint.href) {
  throw new Error(`protected-resource metadata advertises ${protectedResource?.resource ?? "<missing>"} instead of ${endpoint.href}`);
}
if (!Array.isArray(protectedResource?.authorization_servers) || protectedResource.authorization_servers.length === 0) {
  throw new Error("protected-resource metadata does not advertise an authorization server");
}

const authorizationServer = requireHttpsAbsoluteUrl(
  protectedResource.authorization_servers[0],
  "protected-resource authorization server",
);
const authorizationMetadataUrl = new URL("/.well-known/oauth-authorization-server", authorizationServer);
authorizationMetadataUrl.searchParams.set("resource", endpoint.href);
const authorizationMetadata = await jsonResponse(
  await fetchUrl(authorizationMetadataUrl),
  `OAuth authorization-server metadata (${authMode})`,
  200,
);
if (
  typeof authorizationMetadata?.issuer !== "string" ||
  normalizeIssuer(authorizationMetadata.issuer) !== normalizeIssuer(authorizationServer.href)
) {
  throw new Error(`authorization metadata issuer ${authorizationMetadata?.issuer ?? "<missing>"} does not match ${authorizationServer.href}`);
}

const authorizationEndpoint = requireHttpsAbsoluteUrl(authorizationMetadata?.authorization_endpoint, "authorization_endpoint");
const tokenEndpoint = requireHttpsAbsoluteUrl(authorizationMetadata?.token_endpoint, "token_endpoint");
const registrationEndpoint = requireHttpsAbsoluteUrl(authorizationMetadata?.registration_endpoint, "registration_endpoint");
if (!authorizationMetadata?.code_challenge_methods_supported?.includes?.("S256")) {
  throw new Error("authorization metadata does not advertise PKCE S256");
}
if (!authorizationMetadata?.grant_types_supported?.includes?.("authorization_code")) {
  throw new Error("authorization metadata does not advertise authorization-code support");
}
if (!authorizationMetadata?.grant_types_supported?.includes?.("refresh_token")) {
  throw new Error("authorization metadata does not advertise refresh-token support");
}
if (!authorizationMetadata?.token_endpoint_auth_methods_supported?.includes?.("none")) {
  throw new Error("authorization metadata does not allow public clients at the token endpoint");
}
if (authMode === "native" && authorizationMetadata?.client_id_metadata_document_supported !== true) {
  throw new Error("native authorization metadata does not advertise CIMD support");
}

const tokenProbe = await fetchUrl(tokenEndpoint, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "refresh_token",
    client_id: "cptr-edge-canary-invalid-client",
    refresh_token: "cptr-edge-canary-invalid-refresh",
    resource: endpoint.href,
  }),
});
const tokenProbeContentType = tokenProbe.headers.get("content-type") ?? "";
const tokenProbeBody = tokenProbeContentType.toLowerCase().includes("application/json")
  ? await tokenProbe.json()
  : null;
if (![400, 401].includes(tokenProbe.status) || typeof tokenProbeBody?.error !== "string") {
  const detail = tokenProbeBody
    ? JSON.stringify(tokenProbeBody).slice(0, 240)
    : `content-type=${tokenProbeContentType || "<missing>"}`;
  throw new Error(`OAuth token endpoint qualification returned HTTP ${tokenProbe.status} without a structured OAuth error; ${detail}`);
}

for (const [index, redirectUri] of requiredRedirectUris.entries()) {
  const registration = await jsonResponse(
    await fetchUrl(registrationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: `CPTR edge qualification ${index + 1}`,
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        application_type: "native",
        resource: endpoint.href,
      }),
    }),
    `OAuth DCR edge qualification for ${redirectUri}`,
    201,
  );
  if (typeof registration?.client_id !== "string" || registration.client_id.length === 0) {
    throw new Error(`OAuth DCR edge qualification for ${redirectUri} returned no client_id`);
  }
  if (!registration?.redirect_uris?.includes?.(redirectUri)) {
    throw new Error(`OAuth DCR edge qualification did not preserve redirect URI ${redirectUri}`);
  }

  const verifier = `cptr-edge-canary-${String(index + 1).padStart(2, "0")}-abcdefghijklmnopqrstuvwxyz0123456789`;
  const challengeValue = createHash("sha256").update(verifier).digest("base64url");
  const authorizationUrl = new URL(authorizationEndpoint);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", registration.client_id);
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("code_challenge", challengeValue);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  authorizationUrl.searchParams.set("resource", endpoint.href);
  authorizationUrl.searchParams.set("state", `edge-canary-${index + 1}`);

  const authorizationResponse = await fetchUrl(authorizationUrl);
  if (authorizationResponse.status >= 400) {
    const sample = (await authorizationResponse.text()).slice(0, 240).replace(/\s+/g, " ");
    throw new Error(`OAuth authorization probe for ${redirectUri} returned HTTP ${authorizationResponse.status}; body=${sample || "<empty>"}`);
  }
  const location = authorizationResponse.headers.get("location");
  if (location) {
    const redirect = new URL(location, authorizationUrl);
    const error = redirect.searchParams.get("error");
    if (error) {
      const description = redirect.searchParams.get("error_description") ?? "<missing>";
      throw new Error(`OAuth authorization probe rejected ${redirectUri}: ${error}: ${description}`);
    }
  }
}

console.log(
  `CPTR public edge verified at ${origin}: health, MCP 2026 401 challenge, RFC 9728 ${authMode} metadata, OAuth discovery, PKCE S256, refresh-token capability, DCR, and authorization-stage redirect policy.`,
);
