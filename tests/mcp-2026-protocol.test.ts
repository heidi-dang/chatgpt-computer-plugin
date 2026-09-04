import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function text(path: string): Promise<string> {
  return readFile(new URL(path, root), "utf8");
}

test("production MCP endpoint has a strict 2026-07-28 handler beside legacy sessions", async () => {
  const [manifest, indexSource] = await Promise.all([
    text("package.json"),
    text("server/index.ts"),
  ]);
  const pkg = JSON.parse(manifest) as { dependencies?: Record<string, string> };

  assert.ok(pkg.dependencies?.["@modelcontextprotocol/server"], "v2 server package is required");
  assert.ok(pkg.dependencies?.["@modelcontextprotocol/node"], "v2 Node adapter is required");
  assert.match(indexSource, /createMcpHandler/);
  assert.match(indexSource, /legacy:\s*["']reject["']/);
  assert.match(indexSource, /toNodeHandler/);
  assert.match(indexSource, /2026-07-28/);
});

test("MCP CORS admits the 2026 standard method/name/parameter headers", async () => {
  const indexSource = await text("server/index.ts");
  assert.match(indexSource, /Mcp-Method/);
  assert.match(indexSource, /Mcp-Name/);
  assert.match(indexSource, /Mcp-Param/);
});
