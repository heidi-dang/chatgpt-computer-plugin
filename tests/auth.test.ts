import assert from "node:assert/strict";
import test from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { isMcpRequestAuthorized } from "../server/auth.js";
import { authenticateMcpRequest, createProtectedResourceMetadata } from "../server/auth.js";

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
    },
  );
});
