import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CPTR_PLUGIN_SCHEMA_REVISION,
  CPTR_PLUGIN_VERSION,
  MCP_CONTRACT_VERSION,
  currentPluginUpdateManifest,
} from "../server/release.js";
import { CPTR_APP_VERSION } from "../server/version.js";

const packageMetadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  name?: string;
  version?: string;
};
const lockMetadata = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as {
  version?: string;
  packages?: Record<string, { version?: string }>;
};
const buildSource = readFileSync(new URL("../scripts/build-web.mjs", import.meta.url), "utf8");
const devSource = readFileSync(new URL("../scripts/dev.mjs", import.meta.url), "utf8");
const workbenchSource = readFileSync(new URL("../web/src/workbench.tsx", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
const deployedCheckSource = readFileSync(new URL("../scripts/check-deployed-contract.mjs", import.meta.url), "utf8");

test("package.json is the canonical CPTR Computer application version", () => {
  assert.equal(packageMetadata.name, "chatgpt-computer-plugin");
  assert.match(packageMetadata.version ?? "", /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  assert.equal(CPTR_APP_VERSION, packageMetadata.version);
  assert.equal(lockMetadata.version, CPTR_APP_VERSION);
  assert.equal(lockMetadata.packages?.[""]?.version, CPTR_APP_VERSION);
  assert.equal(CPTR_PLUGIN_VERSION, CPTR_APP_VERSION);
  assert.equal(CPTR_PLUGIN_SCHEMA_REVISION, CPTR_APP_VERSION);
  assert.equal(MCP_CONTRACT_VERSION, CPTR_APP_VERSION);
  assert.equal(currentPluginUpdateManifest().version, CPTR_APP_VERSION);
});

test("server, deployment verifier, and Workbench derive version from the canonical package version", () => {
  assert.match(indexSource, /app_version: CPTR_APP_VERSION/);
  assert.match(deployedCheckSource, /const expectedContractVersion = packageMetadata\.version/);
  assert.match(deployedCheckSource, /clientInfo: \{ name: "cptr-deployed-contract-check", version: expectedContractVersion \}/);
  assert.match(buildSource, /__CPTR_APP_VERSION__: JSON\.stringify\(version\)/);
  assert.match(devSource, /__CPTR_APP_VERSION__: JSON\.stringify\(appVersion\)/);
  assert.match(workbenchSource, /clientInfo: \{ name: "cptr-live-terminal", version: CPTR_APP_VERSION \}/);
});
