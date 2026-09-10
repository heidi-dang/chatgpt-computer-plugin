import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import {
  CPTR_PLUGIN_SCHEMA_REVISION,
  CPTR_PLUGIN_VERSION,
  MCP_COMPACT_REGISTERED_TOOL_COUNT,
  MCP_CONTRACT_TOOL_COUNT,
  MCP_CONTRACT_VERSION,
  MCP_LEGACY_REGISTERED_TOOL_COUNT,
  currentPluginUpdateManifest,
} from "../server/release.js";
import { CPTR_APP_VERSION } from "../server/version.js";

const packageMetadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
const serverSource = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
const mcpSource = readFileSync(new URL("../server/mcp.ts", import.meta.url), "utf8");
const workbenchSource = readFileSync(new URL("../web/src/workbench.tsx", import.meta.url), "utf8");
const terminalSource = readFileSync(new URL("../web/src/terminal-view.tsx", import.meta.url), "utf8");
const workbenchCss = readFileSync(new URL("../web/src/workbench.css", import.meta.url), "utf8");
const updateWidgetUrl = new URL("../web/src/plugin-update.tsx", import.meta.url);

test("publishes a bounded CPTR update manifest for the current MCP contract", () => {
  const manifest = currentPluginUpdateManifest({ GIT_COMMIT_SHA: "abc123" });
  assert.match(packageMetadata.version ?? "", /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  assert.equal(CPTR_APP_VERSION, packageMetadata.version);
  assert.equal(CPTR_PLUGIN_VERSION, CPTR_APP_VERSION);
  assert.equal(CPTR_PLUGIN_SCHEMA_REVISION, CPTR_APP_VERSION);
  assert.equal(MCP_CONTRACT_VERSION, CPTR_APP_VERSION);
  assert.equal(MCP_CONTRACT_TOOL_COUNT, 80);
  assert.equal(MCP_LEGACY_REGISTERED_TOOL_COUNT, 87);
  assert.equal(MCP_COMPACT_REGISTERED_TOOL_COUNT, 16);
  assert.equal(manifest.version, CPTR_PLUGIN_VERSION);
  assert.equal(manifest.contract_version, MCP_CONTRACT_VERSION);
  assert.equal(manifest.tool_surface, "legacy");
  assert.equal(manifest.tool_count, MCP_LEGACY_REGISTERED_TOOL_COUNT);
  assert.equal(manifest.registered_tool_count, MCP_LEGACY_REGISTERED_TOOL_COUNT);
  assert.equal(manifest.core_tool_count, MCP_CONTRACT_TOOL_COUNT);
  assert.equal(manifest.legacy_registered_tool_count, MCP_LEGACY_REGISTERED_TOOL_COUNT);
  const compactManifest = currentPluginUpdateManifest({ GIT_COMMIT_SHA: "abc123" }, "compact");
  assert.equal(compactManifest.tool_surface, "compact");
  assert.equal(compactManifest.tool_count, MCP_COMPACT_REGISTERED_TOOL_COUNT);
  assert.equal(compactManifest.registered_tool_count, MCP_COMPACT_REGISTERED_TOOL_COUNT);
  assert.equal(compactManifest.core_tool_count, MCP_CONTRACT_TOOL_COUNT);
  assert.equal(manifest.release_sha, "abc123");
  assert.equal(manifest.released_at, "2026-09-08");
  assert.match(manifest.summary, /Capability OS/);
  const datedManifest = currentPluginUpdateManifest({
    GIT_COMMIT_SHA: "abc123",
    CPTR_RELEASED_AT: "2026-09-09",
  });
  assert.equal(datedManifest.released_at, "2026-09-09");
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

test("Workbench omits the release/update card while the MCP update contract remains available", () => {
  assert.equal(existsSync(updateWidgetUrl), false);
  assert.doesNotMatch(workbenchSource, /PluginUpdateCenter|updateManifestUrl|updateCenter=/);
  assert.doesNotMatch(terminalSource, /updateCenter|terminal-update-center/);
  assert.doesNotMatch(workbenchCss, /\.plugin-update|\.terminal-update-center/);
  assert.match(mcpSource, /server\.registerTool\(\s*"cptr_plugin_update"/);
  assert.match(mcpSource, /const manifest = currentPluginUpdateManifest\(process\.env, toolSurface\)/);
  assert.match(serverSource, /url\.pathname === "\/plugin\/update"/);
});
