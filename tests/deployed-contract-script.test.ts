import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../scripts/check-deployed-contract.mjs", import.meta.url), "utf8");
const packageMetadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };

test("deployed contract verifier supports exact compact production and legacy rollback profiles", () => {
  const compactBlock = source.match(/const compactExpectedTools = \[(.*?)\];/s)?.[1] ?? "";
  const legacyBlock = source.match(/const legacyExpectedTools = \[(.*?)\];/s)?.[1] ?? "";
  const compactTools = [...compactBlock.matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort();
  const legacyTools = [...legacyBlock.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  const expectedCompact = [
    "cptr_agent_monitor",
    "cptr_agent_task",
    "cptr_benchmark",
    "cptr_chrome_browser",
    "cptr_code",
    "cptr_command",
    "cptr_factory",
    "cptr_fdx_intelligence",
    "cptr_lsp",
    "cptr_memory",
    "cptr_open_live_workbench",
    "cptr_plugin_update",
    "cptr_render_live_terminal",
    "cptr_ssh",
    "cptr_user_chrome",
    "cptr_workbench",
    "cptr_worker",
    "cptr_workspace",
  ].sort();

  assert.deepEqual(compactTools, expectedCompact);
  assert.equal(legacyTools.length, 91);
  assert.equal(legacyTools.includes("cptr_memory"), true);
  assert.equal(legacyTools.includes("cptr_factory_start"), true);
  assert.equal(legacyTools.includes("cptr_direct_worker_create"), true);
  assert.match(source, /CPTR_EXPECTED_TOOL_SURFACE/);
  assert.match(source, /compact.*legacy|legacy.*compact/s);
  assert.match(source, /expectedToolSurface === "compact"/);
  assert.match(source, /Buffer\.byteLength\(JSON\.stringify\(tools\)\)/);
  assert.match(source, /100_000/);
  assert.match(packageMetadata.version ?? "", /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  assert.match(source, /const expectedContractVersion = packageMetadata\.version;/);
  assert.match(source, /health\?\.app_version !== expectedContractVersion/);
});

test("deployed contract verifier pins the modern MCP 2026-07-28 era", () => {
  assert.match(source, /versionNegotiation/);
  assert.match(source, /2026-07-28/);
  assert.doesNotMatch(source, /2026-01-26/);
  assert.doesNotMatch(source, /rpc\("initialize"/);
});
