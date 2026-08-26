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
