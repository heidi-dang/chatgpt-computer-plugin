import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../scripts/check-deployed-contract.mjs", import.meta.url), "utf8");
const packageMetadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };

test("deployed contract verifier tracks the current 90-action update-center contract", () => {
  const toolsBlock = source.match(/const expectedTools = \[(.*?)\];/s)?.[1] ?? "";
  const tools = [...toolsBlock.matchAll(/"([^"]+)"/g)].map((match) => match[1]);

  assert.equal(tools.length, 90);
  assert.equal(tools.includes("cptr_chrome_browser"), true);
  assert.equal(tools.includes("cptr_user_chrome"), true);
  assert.equal(tools.includes("cptr_plugin_update"), true);
  assert.equal(tools.includes("cptr_list_workbench_sessions"), true);
  assert.equal(tools.includes("cptr_workspace_run_test_target"), true);
  assert.equal(tools.includes("cptr_fdx_intelligence"), true);
  assert.equal(tools.includes("cptr_direct_worker_create"), true);
  assert.equal(tools.includes("cptr_factory_start"), true);
  assert.equal(tools.includes("cptr_factory_approve"), true);
  assert.equal(tools.includes("cptr_factory_stop"), true);
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
