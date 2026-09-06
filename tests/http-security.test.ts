import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  corsHeaders,
  isAllowedBrowserOrigin,
  isAllowedMcpBrowserOrigin,
  isAllowedOAuthConsentOrigin,
  isAllowedWorkbenchBrowserOrigin,
  mcpCorsHeaders,
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

test("allows only explicitly configured Chrome extension origins", () => {
  const extensionOrigin = "chrome-extension://jgffclmbhhlgoloondkchodehenicfbl";
  const allowed = resolveAllowedOrigins({ MCP_ALLOWED_ORIGINS: `https://chatgpt.com, ${extensionOrigin}` });

  assert.equal(isAllowedBrowserOrigin(extensionOrigin, allowed), true);
  assert.equal(isAllowedBrowserOrigin("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", allowed), false);
  assert.deepEqual(corsHeaders(extensionOrigin, allowed), {
    "Access-Control-Allow-Origin": extensionOrigin,
    Vary: "Origin",
  });
  assert.throws(
    () => resolveAllowedOrigins({ MCP_ALLOWED_ORIGINS: "chrome-extension://not-an-extension-id" }),
    /32-character-id/i,
  );
  assert.throws(
    () => resolveAllowedOrigins({ MCP_ALLOWED_ORIGINS: `${extensionOrigin}/options.html` }),
    /exact chrome-extension/i,
  );
});

test("allows the ChatGPT Apps SDK sandbox only for MCP and Workbench browser traffic", () => {
  const allowed = resolveAllowedOrigins({ MCP_ALLOWED_ORIGINS: "https://chatgpt.com" });
  const widgetOrigin = "https://mcp-example-com.web-sandbox.oaiusercontent.com";

  assert.equal(isAllowedBrowserOrigin(widgetOrigin, allowed), false);
  assert.equal(isAllowedMcpBrowserOrigin(widgetOrigin, allowed), true);
  assert.equal(isAllowedMcpBrowserOrigin("https://web-sandbox.oaiusercontent.com", allowed), true);
  assert.equal(isAllowedMcpBrowserOrigin("https://evil-web-sandbox.oaiusercontent.com.example", allowed), false);
  assert.equal(isAllowedMcpBrowserOrigin("http://mcp-example-com.web-sandbox.oaiusercontent.com", allowed), false);
  assert.deepEqual(mcpCorsHeaders(widgetOrigin, allowed), {
    "Access-Control-Allow-Origin": widgetOrigin,
    Vary: "Origin",
  });
  assert.equal(isAllowedWorkbenchBrowserOrigin(widgetOrigin, allowed), true);
  assert.deepEqual(workbenchCorsHeaders(widgetOrigin, allowed), {
    "Access-Control-Allow-Origin": widgetOrigin,
    Vary: "Origin",
  });
});

test("allows opaque-origin OAuth consent only for the expected form POST", () => {
  const allowed = resolveAllowedOrigins({ MCP_ALLOWED_ORIGINS: "https://chatgpt.com" });
  const publicOrigin = "https://gcloud-cptr.tnaprovider.com.au";

  assert.equal(isAllowedOAuthConsentOrigin(undefined, "POST", "application/x-www-form-urlencoded", publicOrigin, allowed), true);
  assert.equal(isAllowedOAuthConsentOrigin(publicOrigin, "GET", undefined, publicOrigin, allowed), true);
  assert.equal(isAllowedOAuthConsentOrigin("https://chatgpt.com", "POST", "application/x-www-form-urlencoded", publicOrigin, allowed), true);
  assert.equal(isAllowedOAuthConsentOrigin("null", "POST", "application/x-www-form-urlencoded", publicOrigin, allowed), true);
  assert.equal(isAllowedOAuthConsentOrigin("null", "POST", "application/x-www-form-urlencoded; charset=UTF-8", publicOrigin, allowed), true);
  assert.equal(isAllowedOAuthConsentOrigin("null", "GET", undefined, publicOrigin, allowed), false);
  assert.equal(isAllowedOAuthConsentOrigin("null", "POST", "application/json", publicOrigin, allowed), false);
  assert.equal(isAllowedOAuthConsentOrigin("https://evil.example", "POST", "application/x-www-form-urlencoded", publicOrigin, allowed), false);
});

test("routes live browser frame and input traffic through Workbench sandbox origin policy", () => {
  const indexSource = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
  const classification = indexSource.match(/const workbenchBrowserRequest =([\s\S]*?);\n  const browserOriginAllowed/);
  assert.ok(classification, "workbench browser request classifier must exist");
  for (const path of [
    "/live/prompt/browser-frame",
    "/live/prompt/browser-input",
    "/live/prompt/browser-return",
    "/live/prompt/browser-stream",
  ]) {
    assert.match(classification[1], new RegExp(path.replaceAll("/", "\\/")), `${path} must use Workbench sandbox origin policy`);
  }
});

test("routes only the MCP transport through the MCP sandbox origin policy", () => {
  const indexSource = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
  assert.match(indexSource, /const mcpBrowserRequest = url\.pathname === mcpPath;/);
  assert.match(indexSource, /mcpBrowserRequest[\s\S]*?isAllowedMcpBrowserOrigin\(requestOrigin, allowedBrowserOrigins\)/);
  assert.match(indexSource, /mcpBrowserRequest[\s\S]*?mcpCorsHeaders\(requestOrigin, allowedBrowserOrigins\)/);
  assert.match(indexSource, /httpServer\.on\("upgrade"[\s\S]*?isAllowedBrowserOrigin\(requestOrigin, allowedBrowserOrigins\)/);
});

test("routes OAuth consent through the dedicated opaque-origin policy", () => {
  const indexSource = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
  assert.match(indexSource, /const isOauthConsentPath = url\.pathname === "\/oauth\/login";/);
  assert.match(indexSource, /isOauthConsentPath[\s\S]*?isAllowedOAuthConsentOrigin\(/);
});

test("permits a localhost public origin only outside production", () => {
  assert.equal(resolvePublicOrigin({}, "127.0.0.1", 8787), "http://127.0.0.1:8787");
});
