import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CPTR_PLUGIN_SCHEMA_REVISION,
  CPTR_PLUGIN_VERSION,
  MCP_CONTRACT_TOOL_COUNT,
  MCP_CONTRACT_VERSION,
  currentPluginUpdateManifest,
} from "../server/release.js";
import { CPTR_APP_VERSION } from "../server/version.js";

const packageMetadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
const serverSource = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
const widgetSource = readFileSync(new URL("../web/src/plugin-update.tsx", import.meta.url), "utf8");

test("publishes a bounded CPTR update manifest for the current MCP contract", () => {
  const manifest = currentPluginUpdateManifest({ GIT_COMMIT_SHA: "abc123" });
  assert.match(packageMetadata.version ?? "", /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  assert.equal(CPTR_APP_VERSION, packageMetadata.version);
  assert.equal(CPTR_PLUGIN_VERSION, CPTR_APP_VERSION);
  assert.equal(CPTR_PLUGIN_SCHEMA_REVISION, CPTR_APP_VERSION);
  assert.equal(MCP_CONTRACT_VERSION, CPTR_APP_VERSION);
  assert.equal(MCP_CONTRACT_TOOL_COUNT, 70);
  assert.equal(manifest.version, CPTR_PLUGIN_VERSION);
  assert.equal(manifest.contract_version, MCP_CONTRACT_VERSION);
  assert.equal(manifest.tool_count, MCP_CONTRACT_TOOL_COUNT);
  assert.equal(manifest.release_sha, "abc123");
  assert.equal(manifest.refresh_required, true);
  assert.equal(manifest.verification.tool, "cptr_plugin_update");
  assert.deepEqual(manifest.verification.arguments, { action: "status" });
  assert.ok(manifest.changes.length >= 3);
});

test("serves update status and emits best-effort MCP tool-list change notifications", () => {
  assert.match(serverSource, /url\.pathname === "\/plugin\/update"/);
  assert.match(serverSource, /server\.sendToolListChanged\(\)/);
  assert.match(serverSource, /CPTR_NOTIFY_TOOL_LIST_CHANGED/);
});

test("Workbench resolves update status through the MCP action before the plugin-origin HTTP fallback", () => {
  assert.match(widgetSource, /callTool\("cptr_plugin_update", \{ action: "status" \}\)/);
  assert.match(widgetSource, /if \(!manifestUrl\) throw toolError/);
  assert.match(widgetSource, /return fetchManifest\(manifestUrl, signal\)/);
  assert.match(widgetSource, /Update available/);
  assert.match(widgetSource, /Verify update/);
  assert.match(widgetSource, /What’s new/);
  assert.match(widgetSource, /candidate\.verification\.tool/);
});
