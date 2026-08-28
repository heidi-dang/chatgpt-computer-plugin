import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../server/mcp.ts", import.meta.url), "utf8");

function registeredToolBlocks(): Array<{ name: string; body: string }> {
  return source.split("server.registerTool(").slice(1).map((part) => {
    const name = part.split('"', 3)[1] ?? "";
    const body = part.split("\n  server.registerTool(", 1)[0] ?? part;
    return { name, body };
  });
}

test("every registered CPTR MCP tool emits Workbench activity metadata", () => {
  const blocks = registeredToolBlocks();
  assert.equal(blocks.length, 69);
  const missing = blocks
    .filter(({ body }) => ![
      "activityResult(",
      "workbenchResult(",
      "renderWorkbenchResult(",
      "initialWorkbenchResult(",
      "publishActivity(",
    ].some((helper) => body.includes(helper)))
    .map(({ name }) => name);

  assert.deepEqual(missing, []);
});
