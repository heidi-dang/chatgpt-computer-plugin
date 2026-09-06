import { inferConnectorApplicationType } from "./mcp-connector-profiles.mjs";

const endpointValue = process.env.CPTR_DEPLOYED_MCP_URL?.trim();
if (!endpointValue) throw new Error("CPTR_DEPLOYED_MCP_URL is required");
const endpoint = new URL(endpointValue);
if (endpoint.protocol !== "https:") throw new Error("CPTR_DEPLOYED_MCP_URL must use HTTPS");

const connectorName = process.env.CPTR_CONNECTOR_NAME?.trim();
if (!connectorName) throw new Error("CPTR_CONNECTOR_NAME is required");
const redirectUris = (process.env.CPTR_CONNECTOR_REDIRECT_URIS ?? "")
  .split(/[\n,]+/)
  .map((value) => value.trim())
  .filter(Boolean);
if (redirectUris.length === 0) throw new Error("CPTR_CONNECTOR_REDIRECT_URIS must contain at least one URI");
const applicationType = process.env.CPTR_CONNECTOR_APPLICATION_TYPE?.trim() || inferConnectorApplicationType(redirectUris);
if (applicationType !== "native" && applicationType !== "web") {
  throw new Error("CPTR_CONNECTOR_APPLICATION_TYPE must be native or web");
}

const timeoutMs = Number.parseInt(process.env.CPTR_CONNECTOR_TIMEOUT_MS ?? "10000", 10);
const effectiveTimeoutMs = Number.isFinite(timeoutMs) ? timeoutMs : 10_000;

async function fetchUrl(url, init = {}) {
  return await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(effectiveTimeoutMs),
    ...init,
  });
}

async function jsonResponse(response, label, expectedStatus) {
  const contentType = response.headers.get("content-type") ?? "";
  if (response.status !== expectedStatus) {
    const sample = (await response.text()).slice(0, 240).replace(/\s+/g, " ");
    throw new Error(`${label} returned HTTP ${response.status}, expected ${expectedStatus}; body=${sample || "<empty>"}`);
  }
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error(`${label} returned unexpected content-type ${contentType || "<missing>"}`);
  }
  return await response.json();
}

const challengeResponse = await fetchUrl(endpoint, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": "2026-07-28",
    "Mcp-Method": "server/discover",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: "connector-bootstrap",
    method: "server/discover",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: connectorName, version: "1.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  }),
});
if (challengeResponse.status !== 401) {
  const sample = (await challengeResponse.text()).slice(0, 240).replace(/\s+/g, " ");
  throw new Error(`MCP endpoint returned HTTP ${challengeResponse.status}, expected an OAuth 401 challenge; body=${sample || "<empty>"}`);
}
const challenge = challengeResponse.headers.get("www-authenticate") ?? "";
const resourceMetadataValue = challenge.match(/resource_metadata="([^"]+)"/)?.[1];
if (!resourceMetadataValue) throw new Error("MCP 401 challenge did not advertise RFC 9728 resource_metadata");
const resourceMetadataUrl = new URL(resourceMetadataValue);
const protectedResource = await jsonResponse(await fetchUrl(resourceMetadataUrl), "protected-resource metadata", 200);
if (!Array.isArray(protectedResource?.authorization_servers) || protectedResource.authorization_servers.length === 0) {
  throw new Error("protected-resource metadata did not advertise an authorization server");
}
const authorizationServer = new URL(protectedResource.authorization_servers[0]);
const authorizationMetadataUrl = new URL("/.well-known/oauth-authorization-server", authorizationServer);
authorizationMetadataUrl.searchParams.set("resource", endpoint.href);
const authorizationMetadata = await jsonResponse(await fetchUrl(authorizationMetadataUrl), "authorization-server metadata", 200);
const registrationEndpoint = authorizationMetadata?.registration_endpoint;
if (typeof registrationEndpoint !== "string" || !registrationEndpoint) {
  throw new Error("authorization server does not advertise dynamic client registration");
}
if (!authorizationMetadata?.code_challenge_methods_supported?.includes?.("S256")) {
  throw new Error("authorization server does not advertise PKCE S256");
}
if (!authorizationMetadata?.grant_types_supported?.includes?.("authorization_code")) {
  throw new Error("authorization server does not advertise authorization_code");
}

const registration = await jsonResponse(await fetchUrl(new URL(registrationEndpoint), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    client_name: connectorName,
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    application_type: applicationType,
    resource: endpoint.href,
  }),
}), "dynamic client registration", 201);

if (typeof registration?.client_id !== "string" || !registration.client_id) {
  throw new Error("dynamic client registration returned no client_id");
}
if (registration?.token_endpoint_auth_method && registration.token_endpoint_auth_method !== "none") {
  throw new Error("authorization server did not register this connector as a public client");
}

console.log(JSON.stringify({
  mcp_server_url: endpoint.href,
  client_id: registration.client_id,
  client_name: connectorName,
  redirect_uris: registration.redirect_uris ?? redirectUris,
  application_type: registration.application_type ?? applicationType,
  authorization_endpoint: authorizationMetadata.authorization_endpoint,
  token_endpoint: authorizationMetadata.token_endpoint,
  scopes_supported: authorizationMetadata.scopes_supported ?? protectedResource.scopes_supported ?? [],
  resource: endpoint.href,
}, null, 2));
