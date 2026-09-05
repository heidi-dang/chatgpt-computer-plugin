import assert from "node:assert/strict";
import test from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { isMcpRequestAuthorized } from "../server/auth.js";
import {
  authenticateCloudflareLoginIdentity,
  authenticateMcpRequest,
  createBearerChallenge,
  createProtectedResourceMetadata,
  protectedResourceMetadataPath,
} from "../server/auth.js";

test("accepts the configured bearer token", () => {
  const request = new Request("https://mcp.example.test/mcp", {
    headers: { Authorization: "Bearer private-test-token" },
  });

  assert.equal(isMcpRequestAuthorized(request.headers.get("authorization") ?? undefined, "private-test-token"), true);
});

test("rejects missing, malformed, and incorrect bearer credentials", () => {
  const cases = [
    new Request("https://mcp.example.test/mcp"),
    new Request("https://mcp.example.test/mcp", { headers: { Authorization: "Basic private-test-token" } }),
    new Request("https://mcp.example.test/mcp", { headers: { Authorization: "Bearer wrong-token" } }),
  ];

  for (const request of cases) {
    assert.equal(isMcpRequestAuthorized(request.headers.get("authorization") ?? undefined, "private-test-token"), false);
  }
});

test("fails closed when the server token is not configured", () => {
  const request = new Request("https://mcp.example.test/mcp", {
    headers: { Authorization: "Bearer private-test-token" },
  });

  assert.equal(isMcpRequestAuthorized(request.headers.get("authorization") ?? undefined, undefined), false);
});

test("accepts a valid Cloudflare Access assertion for the configured resource", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }] });
  const assertion = await new SignJWT({ email: "heidi.dang.dev@gmail.com", scope: "openid email" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer("https://heidiluong.cloudflareaccess.com")
    .setAudience("test-audience")
    .setSubject("test-subject")
    .setIssuedAt()
    .setNotBefore("0s")
    .setExpirationTime("5m")
    .sign(privateKey);

  const result = await authenticateMcpRequest(
    { cloudflareAssertion: assertion },
    {
      staticToken: undefined,
      cloudflare: {
        issuer: "https://heidiluong.cloudflareaccess.com",
        audience: "test-audience",
        resource: "https://mcp.example.test/mcp",
        allowedEmail: "heidi.dang.dev@gmail.com",
        requiredScopes: ["openid", "email"],
        jwks,
      },
    },
  );

  assert.deepEqual(result, {
    authorized: true,
    mechanism: "cloudflare",
    email: "heidi.dang.dev@gmail.com",
    subject: "test-subject",
  });
});

test("Cloudflare-backed OAuth login fails closed without an Access assertion", async () => {
  const { publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }] });

  const identity = await authenticateCloudflareLoginIdentity(undefined, {
    issuer: "https://issuer.example.test",
    audience: "test-audience",
    resource: "https://mcp.example.test/mcp",
    allowedEmail: "user@example.test",
    requiredScopes: [],
    jwks,
  });

  assert.equal(identity, null);
});

test("accepts a short-lived resource-bound native OAuth access token", async () => {
  const secret = "s".repeat(48);
  const assertion = await new SignJWT({ token_use: "access", client_id: "chatgpt-test-client", scope: "mcp" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer("https://mcp.example.test")
    .setAudience("https://mcp.example.test/mcp")
    .setSubject("test-user")
    .setIssuedAt()
    .setNotBefore("0s")
    .setExpirationTime("60s")
    .sign(new TextEncoder().encode(secret));

  const result = await authenticateMcpRequest(
    { authorization: `Bearer ${assertion}` },
    {
      staticToken: undefined,
      cloudflare: undefined,
      nativeOAuth: {
        issuer: "https://mcp.example.test",
        audience: "https://mcp.example.test/mcp",
        secret,
      },
    },
  );

  assert.deepEqual(result, {
    authorized: true,
    mechanism: "native-oauth",
    subject: "test-user",
    clientId: "chatgpt-test-client",
    scope: "mcp",
  });
});

test("rejects native OAuth access tokens with wrong issuer, audience, expiry, nbf, token use, or missing subject", async () => {
  const secret = "s".repeat(48);
  const base = {
    staticToken: undefined,
    cloudflare: undefined,
    nativeOAuth: {
      issuer: "https://mcp.example.test",
      audience: "https://mcp.example.test/mcp",
      secret,
    },
  } as const;

  const makeAssertion = async (overrides: Record<string, unknown> = {}) => {
    const jwt = new SignJWT({
      token_use: overrides.token_use ?? "access",
      client_id: "chatgpt-test-client",
      scope: "mcp",
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(typeof overrides.issuer === "string" ? overrides.issuer : base.nativeOAuth.issuer)
      .setAudience(typeof overrides.audience === "string" ? overrides.audience : base.nativeOAuth.audience)
      .setIssuedAt()
      .setNotBefore(typeof overrides.nbf === "string" ? overrides.nbf : "0s")
      .setExpirationTime(typeof overrides.exp === "string" ? overrides.exp : "60s");
    if (overrides.missingSubject !== true) jwt.setSubject("test-user");
    return jwt.sign(new TextEncoder().encode(secret));
  };

  for (const overrides of [
    { issuer: "https://wrong.example.test" },
    { audience: "https://wrong.example.test/mcp" },
    { exp: "-1s" },
    { nbf: "10m" },
    { token_use: "refresh" },
    { missingSubject: true },
  ]) {
    const result = await authenticateMcpRequest({ authorization: `Bearer ${await makeAssertion(overrides)}` }, base);
    assert.equal(result.authorized, false);
  }
});

test("rejects Cloudflare assertions with wrong issuer, audience, expiry, nbf, email, or scope", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }] });
  const base = {
    staticToken: undefined,
    cloudflare: {
      issuer: "https://issuer.example.test",
      audience: "test-audience",
      resource: "https://mcp.example.test/mcp",
      allowedEmail: "heidi.dang.dev@gmail.com",
      requiredScopes: ["openid", "email"],
      jwks,
    },
  } as const;

  const makeAssertion = async (overrides: Record<string, unknown> = {}) =>
    new SignJWT({ email: "heidi.dang.dev@gmail.com", scope: "openid email", ...overrides })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(typeof overrides.issuer === "string" ? overrides.issuer : base.cloudflare.issuer)
      .setAudience(typeof overrides.audience === "string" ? overrides.audience : base.cloudflare.audience)
      .setSubject("test-subject")
      .setIssuedAt()
      .setNotBefore(typeof overrides.nbf === "string" ? overrides.nbf : "0s")
      .setExpirationTime(typeof overrides.exp === "string" ? overrides.exp : "5m")
      .sign(privateKey);

  for (const overrides of [
    { issuer: "https://wrong.example.test" },
    { audience: "wrong-audience" },
    { exp: "-1s" },
    { nbf: "10m" },
    { email: "someone-else@example.test" },
    { scope: "openid" },
  ]) {
    const result = await authenticateMcpRequest({ cloudflareAssertion: await makeAssertion(overrides) }, base);
    assert.equal(result.authorized, false);
  }
});

test("publishes protected-resource metadata with the configured resource and authorization server", () => {
  assert.deepEqual(
    createProtectedResourceMetadata({
      resource: "https://mcp.example.test/mcp",
      authorizationServer: "https://heidiluong.cloudflareaccess.com",
      scopes: ["openid", "email"],
    }),
    {
      resource: "https://mcp.example.test/mcp",
      authorization_servers: ["https://heidiluong.cloudflareaccess.com"],
      scopes_supported: ["openid", "email"],
      bearer_methods_supported: ["header"],
    },
  );
});

test("uses the path-specific RFC 9728 metadata location for an MCP endpoint", () => {
  assert.equal(protectedResourceMetadataPath("/mcp"), "/.well-known/oauth-protected-resource/mcp");
});

test("publishes an RFC 6750 bearer challenge with resource metadata and configured scopes", () => {
  assert.equal(
    createBearerChallenge(
      "https://mcp.example.test/.well-known/oauth-protected-resource/mcp",
      ["files:read", "tools:execute"],
    ),
    'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp", scope="files:read tools:execute"',
  );
});

test("omits the scope parameter when no OAuth scopes are configured", () => {
  assert.equal(
    createBearerChallenge("https://mcp.example.test/.well-known/oauth-protected-resource/mcp", []),
    'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"',
  );
});
