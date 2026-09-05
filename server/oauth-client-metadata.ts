import { lookup } from "node:dns/promises";
import { createHash } from "node:crypto";
import https from "node:https";
import net from "node:net";
import { jwtVerify, SignJWT } from "jose";

export type OAuthClientMetadata = {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: "none";
  applicationType: "native" | "web";
};

export type DynamicClientRegistrationInput = {
  client_name?: unknown;
  redirect_uris?: unknown;
  grant_types?: unknown;
  response_types?: unknown;
  token_endpoint_auth_method?: unknown;
  application_type?: unknown;
};

const DCR_PREFIX = "urn:cptr:oauth-client:";
const MAX_METADATA_BYTES = 32_768;
const MAX_CACHE_ENTRIES = 256;
const DEFAULT_CACHE_MS = 5 * 60_000;
const MAX_CACHE_MS = 60 * 60_000;

const blockedAddresses = new net.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blockedAddresses.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["2001:db8::", 32], ["ff00::", 8],
] as const) blockedAddresses.addSubnet(network, prefix, "ipv6");

type CacheEntry = { metadata: OAuthClientMetadata; expiresAt: number };
const metadataCache = new Map<string, CacheEntry>();

function encodedSecret(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const result = value.map((entry) => typeof entry === "string" ? entry.trim() : "").filter(Boolean);
  return result.length === value.length ? result : null;
}

export function validateRedirectUri(value: string): string {
  const url = new URL(value);
  if (url.hash) throw new Error("redirect_uri must not include a fragment");
  if (url.protocol === "https:") return url.href;
  if (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return url.href;
  throw new Error("redirect_uri must use HTTPS or an HTTP loopback host");
}

function normalizedClientMetadata(input: {
  clientId: string;
  clientName: unknown;
  redirectUris: unknown;
  grantTypes?: unknown;
  responseTypes?: unknown;
  tokenEndpointAuthMethod?: unknown;
  tokenEndpointAuthMethodsSupported?: unknown;
  applicationType?: unknown;
}): OAuthClientMetadata {
  const clientName = typeof input.clientName === "string" ? input.clientName.trim() : "";
  if (!clientName || clientName.length > 160) throw new Error("client_name is required");
  const redirectUris = stringArray(input.redirectUris);
  if (!redirectUris || redirectUris.length > 20) throw new Error("redirect_uris is required");
  const normalizedRedirects = [...new Set(redirectUris.map(validateRedirectUri))];
  if (Array.isArray(input.grantTypes) && !input.grantTypes.includes("authorization_code")) {
    throw new Error("authorization_code grant is required");
  }
  if (Array.isArray(input.responseTypes) && !input.responseTypes.includes("code")) {
    throw new Error("code response type is required");
  }
  let authMethod = input.tokenEndpointAuthMethod ?? "none";
  const supportedMethods = Array.isArray(input.tokenEndpointAuthMethodsSupported) ? input.tokenEndpointAuthMethodsSupported : [authMethod];
  
  if (authMethod !== "none" && !supportedMethods.includes("none")) {
    throw new Error("only public clients using token_endpoint_auth_method=none are supported");
  }
  
  const applicationType = input.applicationType ?? "web";
  if (applicationType !== "native" && applicationType !== "web") {
    throw new Error("application_type must be native or web");
  }
  return {
    clientId: input.clientId,
    clientName,
    redirectUris: normalizedRedirects,
    tokenEndpointAuthMethod: "none",
    applicationType,
  };
}

export async function issueDynamicClientId(
  input: DynamicClientRegistrationInput,
  config: { issuer: string; secret: string },
): Promise<{ clientId: string; metadata: OAuthClientMetadata; issuedAt: number }> {
  const provisional = normalizedClientMetadata({
    clientId: "pending",
    clientName: input.client_name,
    redirectUris: input.redirect_uris,
    grantTypes: input.grant_types,
    responseTypes: input.response_types,
    tokenEndpointAuthMethod: input.token_endpoint_auth_method,
    applicationType: input.application_type,
  });
  const issuedAt = Math.floor(Date.now() / 1000);
  const registration = await new SignJWT({
    typ: "dcr-client",
    client_name: provisional.clientName,
    redirect_uris: provisional.redirectUris,
    token_endpoint_auth_method: "none",
    application_type: provisional.applicationType,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(config.issuer)
    .setAudience(`${config.issuer}/oauth/register`)
    .setIssuedAt(issuedAt)
    .sign(encodedSecret(config.secret));
  const clientId = `${DCR_PREFIX}${registration}`;
  return { clientId, metadata: { ...provisional, clientId }, issuedAt };
}

async function resolveDynamicClientId(
  clientId: string,
  config: { issuer: string; secret: string },
): Promise<OAuthClientMetadata | null> {
  if (!clientId.startsWith(DCR_PREFIX)) return null;
  const token = clientId.slice(DCR_PREFIX.length);
  const { payload } = await jwtVerify(token, encodedSecret(config.secret), {
    algorithms: ["HS256"],
    issuer: config.issuer,
    audience: `${config.issuer}/oauth/register`,
  });
  if (payload.typ !== "dcr-client") throw new Error("invalid dynamic client registration");
  return normalizedClientMetadata({
    clientId,
    clientName: payload.client_name,
    redirectUris: payload.redirect_uris,
    tokenEndpointAuthMethod: payload.token_endpoint_auth_method,
    applicationType: payload.application_type,
  });
}

function maxAgeMs(cacheControl: string | undefined): number {
  const match = cacheControl?.match(/(?:^|,)\s*max-age=(\d+)/i);
  if (!match) return DEFAULT_CACHE_MS;
  return Math.min(MAX_CACHE_MS, Math.max(0, Number(match[1]) * 1000));
}

function assertPublicAddress(address: string, family: 4 | 6): void {
  if (blockedAddresses.check(address, family === 4 ? "ipv4" : "ipv6")) {
    throw new Error("client metadata host resolves to a non-public address");
  }
}

async function fetchMetadataDocument(clientId: string): Promise<{ body: unknown; cacheMs: number }> {
  const url = new URL(clientId);
  if (url.protocol !== "https:" || url.username || url.password || !url.pathname || url.pathname === "/" || url.hash) {
    throw new Error("CIMD client_id must be an HTTPS URL with a path and no fragment or credentials");
  }
  if (url.port && url.port !== "443") throw new Error("CIMD client_id must use the default HTTPS port");
  if (url.hostname.toLowerCase() === "localhost" || url.hostname.toLowerCase().endsWith(".local")) {
    throw new Error("CIMD client metadata host must be public");
  }
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length) throw new Error("CIMD client metadata host did not resolve");
  for (const address of addresses) {
    const ip = typeof address === "string" ? address : address.address;
    const family = typeof address === "string" ? (ip.includes(":") ? 6 : 4) : address.family;
    assertPublicAddress(ip, family as 4 | 6);
  }
  const selectedRaw = addresses[0] as any;
  const selected = typeof selectedRaw === "string"
    ? { address: selectedRaw, family: selectedRaw.includes(":") ? 6 : 4 }
    : selectedRaw;

  return await new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: "GET",
      headers: { accept: "application/json" },
      servername: url.hostname,
      lookup: (_hostname, _options, callback) => callback(null, [{ address: selected.address, family: selected.family as 4 | 6 }]),
      timeout: 3_000,
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error("CIMD metadata request did not return 200"));
        return;
      }
      const contentType = String(response.headers["content-type"] ?? "").toLowerCase();
      if (!contentType.includes("application/json")) {
        response.resume();
        reject(new Error("CIMD metadata response must be JSON"));
        return;
      }
      const declaredLength = Number(response.headers["content-length"] ?? 0);
      if (declaredLength > MAX_METADATA_BYTES) {
        response.resume();
        reject(new Error("CIMD metadata response is too large"));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > MAX_METADATA_BYTES) {
          request.destroy(new Error("CIMD metadata response is too large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          resolve({
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            cacheMs: maxAgeMs(Array.isArray(response.headers["cache-control"])
              ? response.headers["cache-control"][0]
              : response.headers["cache-control"]),
          });
        } catch {
          reject(new Error("CIMD metadata response is invalid JSON"));
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("CIMD metadata request timed out")));
    request.on("error", reject);
    request.end();
  });
}

async function resolveCimdClientId(clientId: string): Promise<OAuthClientMetadata | null> {
  let url: URL;
  try { url = new URL(clientId); } catch { return null; }
  if (url.protocol !== "https:") return null;
  const cached = metadataCache.get(clientId);
  if (cached && cached.expiresAt > Date.now()) return cached.metadata;
  const { body, cacheMs } = await fetchMetadataDocument(clientId);
  const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  if (!record || record.client_id !== clientId) throw new Error("CIMD metadata client_id must exactly match its document URL");
  const metadata = normalizedClientMetadata({
    clientId,
    clientName: record.client_name,
    redirectUris: record.redirect_uris,
    grantTypes: record.grant_types,
    responseTypes: record.response_types,
    tokenEndpointAuthMethod: record.token_endpoint_auth_method,
    applicationType: record.application_type,
    tokenEndpointAuthMethodsSupported: record.token_endpoint_auth_methods_supported,
  });
  if (metadataCache.size >= MAX_CACHE_ENTRIES) metadataCache.delete(metadataCache.keys().next().value as string);
  metadataCache.set(clientId, { metadata, expiresAt: Date.now() + cacheMs });
  return metadata;
}

export async function resolveOAuthClient(
  clientId: string,
  config: { issuer: string; secret: string },
): Promise<OAuthClientMetadata> {
  const dynamic = await resolveDynamicClientId(clientId, config);
  if (dynamic) return dynamic;
  const cimd = await resolveCimdClientId(clientId);
  if (cimd) return cimd;
  throw new Error("unknown OAuth client_id");
}

export function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}
