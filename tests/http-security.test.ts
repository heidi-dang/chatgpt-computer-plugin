import assert from "node:assert/strict";
import test from "node:test";
import {
  corsHeaders,
  isAllowedBrowserOrigin,
  isAllowedWorkbenchBrowserOrigin,
  resolveAllowedOrigins,
  resolvePublicOrigin,
  workbenchCorsHeaders,
} from "../server/http-security.js";

test("requires explicit public and browser origins in production", () => {
  assert.throws(() => resolvePublicOrigin({ NODE_ENV: "production" }, "127.0.0.1", 8787), /PUBLIC_ORIGIN/);
  assert.throws(() => resolveAllowedOrigins({ NODE_ENV: "production" }), /MCP_ALLOWED_ORIGINS/);
});

test("requires a public HTTPS origin rather than localhost in production", () => {
  assert.throws(
    () => resolvePublicOrigin({ NODE_ENV: "production", PUBLIC_ORIGIN: "http://localhost:8787" }, "127.0.0.1", 8787),
    /HTTPS|localhost/i,
  );
});

test("normalizes configured HTTP origins and allows only listed browser origins", () => {
  const publicOrigin = resolvePublicOrigin({ PUBLIC_ORIGIN: "https://mcp.example.test/" }, "127.0.0.1", 8787);
  const allowed = resolveAllowedOrigins({ MCP_ALLOWED_ORIGINS: "https://chatgpt.com, https://app.example.test/" });

  assert.equal(publicOrigin, "https://mcp.example.test");
  assert.equal(isAllowedBrowserOrigin(undefined, allowed), true);
  assert.equal(isAllowedBrowserOrigin("https://chatgpt.com", allowed), true);
  assert.equal(isAllowedBrowserOrigin("https://evil.example", allowed), false);
  assert.deepEqual(corsHeaders("https://chatgpt.com", allowed), {
    "Access-Control-Allow-Origin": "https://chatgpt.com",
    Vary: "Origin",
  });
  assert.deepEqual(corsHeaders("https://evil.example", allowed), {});
});

test("allows the ChatGPT Apps SDK sandbox only for Workbench browser traffic", () => {
  const allowed = resolveAllowedOrigins({ MCP_ALLOWED_ORIGINS: "https://chatgpt.com" });
  const widgetOrigin = "https://mcp-example-com.web-sandbox.oaiusercontent.com";

  assert.equal(isAllowedBrowserOrigin(widgetOrigin, allowed), false);
  assert.equal(isAllowedWorkbenchBrowserOrigin(widgetOrigin, allowed), true);
  assert.equal(isAllowedWorkbenchBrowserOrigin("https://web-sandbox.oaiusercontent.com", allowed), true);
  assert.equal(isAllowedWorkbenchBrowserOrigin("https://evil-web-sandbox.oaiusercontent.com.example", allowed), false);
  assert.equal(isAllowedWorkbenchBrowserOrigin("http://mcp-example-com.web-sandbox.oaiusercontent.com", allowed), false);
  assert.deepEqual(workbenchCorsHeaders(widgetOrigin, allowed), {
    "Access-Control-Allow-Origin": widgetOrigin,
    Vary: "Origin",
  });
});

test("permits a localhost public origin only outside production", () => {
  assert.equal(resolvePublicOrigin({}, "127.0.0.1", 8787), "http://127.0.0.1:8787");
});
