import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

const BEARER_PREFIX = "Bearer ";

export type CloudflareAccessConfig = {
  issuer: string;
  audience: string;
  resource: string;
  allowedEmail: string;
  requiredScopes: readonly string[];
  jwksUri?: string;
  jwks?: JWTVerifyGetKey;
};

export type McpAuthConfig = {
  staticToken: string | undefined;
  cloudflare: CloudflareAccessConfig | undefined;
};

export type McpAuthResult =
  | { authorized: true; mechanism: "static" }
  | { authorized: true; mechanism: "cloudflare"; email: string; subject: string }
  | { authorized: false; reason: string };

export type ProtectedResourceMetadata = {
  resource: string;
  authorization_servers: string[];
  scopes_supported?: string[];
};

export function isMcpRequestAuthorized(authorization: string | undefined, expectedToken: string | undefined): boolean {
  if (!expectedToken || !authorization?.startsWith(BEARER_PREFIX)) {
    return false;
  }

  return authorization.slice(BEARER_PREFIX.length) === expectedToken;
}

export function createProtectedResourceMetadata(input: {
  resource: string;
  authorizationServer: string;
  scopes?: string[];
}): ProtectedResourceMetadata {
  return {
    resource: input.resource,
    authorization_servers: [input.authorizationServer],
    ...(input.scopes?.length ? { scopes_supported: input.scopes } : {}),
  };
}

function reject(reason: string): McpAuthResult {
  return { authorized: false, reason };
}

export async function authenticateMcpRequest(
  input: { authorization?: string; cloudflareAssertion?: string },
  config: McpAuthConfig,
): Promise<McpAuthResult> {
  if (input.cloudflareAssertion && config.cloudflare) {
    try {
      const jwks = config.cloudflare.jwks ?? (
        config.cloudflare.jwksUri
          ? createRemoteJWKSet(new URL(config.cloudflare.jwksUri))
          : undefined
      );
      if (!jwks) {
        return reject("Cloudflare Access JWKS is not configured");
      }
      const { payload } = await jwtVerify(input.cloudflareAssertion, jwks, {
        algorithms: ["RS256"],
        issuer: config.cloudflare.issuer,
        audience: config.cloudflare.audience,
      });

      if (payload.resource !== undefined && payload.resource !== config.cloudflare.resource) {
        return reject("resource mismatch");
      }

      const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
      if (!email || email !== config.cloudflare.allowedEmail.trim().toLowerCase()) {
        return reject("identity is not allowed");
      }

      const scopes = new Set(
        typeof payload.scope === "string" ? payload.scope.split(/\s+/).filter(Boolean) : [],
      );
      if (config.cloudflare.requiredScopes.some((scope) => !scopes.has(scope))) {
        return reject("required scope is missing");
      }

      if (typeof payload.sub !== "string" || payload.sub.length === 0) {
        return reject("subject is missing");
      }

      return { authorized: true, mechanism: "cloudflare", email, subject: payload.sub };
    } catch {
      return reject("Cloudflare Access assertion is invalid");
    }
  }

  if (isMcpRequestAuthorized(input.authorization, config.staticToken)) {
    return { authorized: true, mechanism: "static" };
  }

  return reject(config.staticToken ? "Unauthorized" : "MCP authentication is not configured");
}
