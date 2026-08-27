import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../scripts/check-deployed-contract.mjs", import.meta.url), "utf8");

test("deployed contract verifier tracks the current 37-tool browser contract", () => {
  const toolsBlock = source.match(/const expectedTools = \[(.*?)\];/s)?.[1] ?? "";
  const tools = [...toolsBlock.matchAll(/"([^"]+)"/g)].map((match) => match[1]);

  assert.equal(tools.length, 37);
  assert.equal(tools.includes("cptr_chrome_browser"), true);
  assert.match(source, /const expectedContractVersion = "0\.7\.0";/);
});
