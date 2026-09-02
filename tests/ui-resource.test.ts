import assert from "node:assert/strict";
import test from "node:test";
import {
  WORKBENCH_RESOURCE_URI,
  createWorkbenchResource,
  validateWorkbenchDomain,
} from "../server/ui/workbench-resource.js";

test("publishes the configured widget domain and bounded MCP Apps metadata", async () => {
  const resource = await createWorkbenchResource(
    "console.log('workbench')",
    "https://mcp.example.test",
    "",
    { enabled: false, buildId: "static-test" },
  );
  const metadata = resource.contents[0]._meta as {
    ui?: {
      domain?: string;
      prefersBorder?: boolean;
      csp?: { connectDomains?: string[]; resourceDomains?: string[] };
    };
  };
  assert.equal(WORKBENCH_RESOURCE_URI.startsWith("ui://"), true);
  assert.equal(resource.contents[0].uri, "ui://cptr/live-workbench.html");
  assert.equal(resource.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.equal(metadata.ui?.domain, "https://mcp.example.test");
  assert.equal(metadata.ui?.prefersBorder, false);
  assert.deepEqual(metadata.ui?.csp?.connectDomains, ["https://mcp.example.test"]);
  assert.deepEqual(metadata.ui?.csp?.resourceDomains, []);
  assert.match(resource.contents[0].text, /console\.log/);
  assert.match(resource.contents[0].text, /data-terminal-static-shell/);
  assert.match(resource.contents[0].text, /CHATGPT LIVE TERMINAL/);
  assert.match(resource.contents[0].text, /Terminal UI ready\./);
  assert.match(resource.contents[0].text, /viewport-fit=cover/);
  assert.doesNotMatch(resource.contents[0].text, /<div id="root"><\/div>/);
});

test("publishes production-safe external assets and a loop-safe reload channel", async () => {
  const resource = await createWorkbenchResource(
    "SHOULD_NOT_BE_INLINE",
    "https://mcp.example.test",
    "INLINE_CSS",
    { enabled: true, buildId: "build-42" },
  );
  const metadata = resource.contents[0]._meta as {
    ui?: { csp?: { connectDomains?: string[]; resourceDomains?: string[] } };
  };
  const html = resource.contents[0].text;
  assert.match(html, /__cptr\/dev\/workbench\.js/);
  assert.match(html, /__cptr\/dev\/workbench\.css/);
  assert.match(html, /__cptr\/dev\/reload/);
  assert.match(html, /build-42/);
  assert.match(html, /min-height:760px/);
  assert.match(html, /min-height:680px/);
  assert.match(html, /min-height:640px/);
  assert.match(html, /sessionStorage\.setItem/);
  assert.match(html, /encodeURIComponent\(current\)/);
  assert.match(html, /source\.close\(\);location\.reload\(\)/);
  assert.doesNotMatch(html, /SHOULD_NOT_BE_INLINE|INLINE_CSS/);
  assert.deepEqual(metadata.ui?.csp?.connectDomains, ["https://mcp.example.test"]);
  assert.deepEqual(metadata.ui?.csp?.resourceDomains, ["https://mcp.example.test"]);
});

test("rejects a localhost widget domain for production configuration", () => {
  assert.throws(
    () => validateWorkbenchDomain("http://localhost:8787", true),
    /HTTPS|localhost/i,
  );
  assert.throws(
    () => validateWorkbenchDomain("https://localhost:8787", true),
    /localhost/i,
  );
});
