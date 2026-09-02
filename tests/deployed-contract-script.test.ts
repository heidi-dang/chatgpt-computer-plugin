import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../scripts/check-deployed-contract.mjs", import.meta.url), "utf8");
const packageMetadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };

test("deployed contract verifier tracks the current 80-action update-center contract", () => {
  const toolsBlock = source.match(/const expectedTools = \[(.*?)\];/s)?.[1] ?? "";
  const tools = [...toolsBlock.matchAll(/"([^"]+)"/g)].map((match) => match[1]);

  assert.equal(tools.length, 80);
  assert.equal(tools.includes("cptr_chrome_browser"), true);
  assert.equal(tools.includes("cptr_plugin_update"), true);
  assert.equal(tools.includes("cptr_list_workbench_sessions"), true);
  assert.equal(tools.includes("cptr_workspace_run_test_target"), true);
  assert.equal(tools.includes("cptr_fdx_intelligence"), true);
  assert.equal(tools.includes("cptr_direct_worker_create"), true);
  assert.match(packageMetadata.version ?? "", /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  assert.match(source, /const expectedContractVersion = packageMetadata\.version;/);
  assert.match(source, /health\?\.app_version !== expectedContractVersion/);
});
