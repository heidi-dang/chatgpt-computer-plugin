import assert from "node:assert/strict";
import test from "node:test";
import { OAuthStateStore } from "../server/oauth-state.js";

test("authorization codes are one-time and expire", () => {
  const store = new OAuthStateStore(":memory:");
  try {
    const code = store.issueAuthorizationCode({
      clientId: "client",
      redirectUri: "https://client.example.test/callback",
      codeChallenge: "challenge",
      resource: "https://mcp.example.test/mcp",
      scope: "mcp",
      subject: "user",
      email: "user@example.test",
    }, 60_000, 1_000);
    assert.equal(store.consumeAuthorizationCode(code, 2_000)?.clientId, "client");
    assert.equal(store.consumeAuthorizationCode(code, 2_001), null);

    const expired = store.issueAuthorizationCode({
      clientId: "client",
      redirectUri: "https://client.example.test/callback",
      codeChallenge: "challenge",
      resource: "https://mcp.example.test/mcp",
      scope: "mcp",
      subject: "user",
      email: null,
    }, 10, 3_000);
    assert.equal(store.consumeAuthorizationCode(expired, 3_011), null);
  } finally {
    store.close();
  }
});

test("refresh tokens rotate and reuse revokes the token family", () => {
  const store = new OAuthStateStore(":memory:");
  try {
    const issued = store.issueRefreshToken({
      clientId: "client",
      resource: "https://mcp.example.test/mcp",
      scope: "mcp",
      subject: "user",
      email: null,
    }, 100_000, 1_000);
    const rotated = store.rotateRefreshToken(issued.token, {
      clientId: "client",
      resource: "https://mcp.example.test/mcp",
    }, 2_000);
    assert.ok(rotated);
    assert.notEqual(rotated.token, issued.token);

    assert.equal(store.rotateRefreshToken(issued.token, {
      clientId: "client",
      resource: "https://mcp.example.test/mcp",
    }, 2_001), null);
    assert.equal(store.rotateRefreshToken(rotated.token, {
      clientId: "client",
      resource: "https://mcp.example.test/mcp",
    }, 2_002), null);
  } finally {
    store.close();
  }
});
