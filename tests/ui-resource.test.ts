import assert from "node:assert/strict";
import test from "node:test";
import { WORKBENCH_RESOURCE_URI, createWorkbenchResource } from "../server/ui/workbench-resource.js";

test("registers an MCP Apps resource with the required MIME type", async () => {
  const resource = await createWorkbenchResource("console.log('workbench')");
  assert.equal(WORKBENCH_RESOURCE_URI.startsWith("ui://"), true);
  assert.equal(resource.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.match(resource.contents[0].text, /console\.log/);
});
