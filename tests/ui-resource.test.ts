import assert from "node:assert/strict";
import test from "node:test";
import {
  WORKBENCH_RESOURCE_URI,
  createWorkbenchResource,
  validateWorkbenchDomain,
} from "../server/ui/workbench-resource.js";

test("publishes the configured widget domain and bounded MCP Apps metadata", async () => {
  const resource = await createWorkbenchResource("console.log('workbench')", "https://mcp.example.test");
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
  assert.equal(metadata.ui?.prefersBorder, true);
  assert.deepEqual(metadata.ui?.csp?.connectDomains, ["https://mcp.example.test"]);
  assert.deepEqual(metadata.ui?.csp?.resourceDomains, []);
  assert.match(resource.contents[0].text, /console\.log/);
});

test("publishes external development assets and reload channel when hot reload is enabled", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousHotReload = process.env.CPTR_HOT_RELOAD;
  const previousBuildId = process.env.CPTR_DEV_BUILD_ID;
  try {
    process.env.NODE_ENV = "development";
    process.env.CPTR_HOT_RELOAD = "1";
    process.env.CPTR_DEV_BUILD_ID = "build-42";
    const resource = await createWorkbenchResource("SHOULD_NOT_BE_INLINE", "http://localhost:8787", "INLINE_CSS");
    const metadata = resource.contents[0]._meta as {
      ui?: { csp?: { connectDomains?: string[]; resourceDomains?: string[] } };
    };
    const html = resource.contents[0].text;
    assert.match(html, /__cptr\/dev\/workbench\.js/);
    assert.match(html, /__cptr\/dev\/workbench\.css/);
    assert.match(html, /__cptr\/dev\/reload/);
    assert.match(html, /build-42/);
    assert.doesNotMatch(html, /SHOULD_NOT_BE_INLINE|INLINE_CSS/);
    assert.deepEqual(metadata.ui?.csp?.connectDomains, ["http://localhost:8787"]);
    assert.deepEqual(metadata.ui?.csp?.resourceDomains, ["http://localhost:8787"]);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousHotReload === undefined) delete process.env.CPTR_HOT_RELOAD;
    else process.env.CPTR_HOT_RELOAD = previousHotReload;
    if (previousBuildId === undefined) delete process.env.CPTR_DEV_BUILD_ID;
    else process.env.CPTR_DEV_BUILD_ID = previousBuildId;
  }
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
