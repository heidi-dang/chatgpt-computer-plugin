import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadWorkbenchAssets, resolveWorkbenchHotReload } from "../server/workbench-assets.js";

test("loads CPTR workbench assets from the deployment working directory", () => {
  const root = mkdtempSync(join(tmpdir(), "cptr-assets-"));
  try {
    const assetDirectory = join(root, "web", "dist");
    mkdirSync(assetDirectory, { recursive: true });
    writeFileSync(join(assetDirectory, "workbench.js"), "console.log('ready');", "utf8");
    writeFileSync(join(assetDirectory, "workbench.css"), ".workbench { color: white; }", "utf8");

    const assets = loadWorkbenchAssets({
      cwd: root,
      moduleUrl: new URL("./dist/server/index.js", `file://${root}/`).href,
    });

    assert.equal(assets.ready, true);
    assert.equal(assets.directory, assetDirectory);
    assert.match(assets.bundle, /console\.log\('ready'\)/);
    assert.match(assets.styles, /color: white/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports a bounded fallback only when CPTR workbench assets are unavailable", () => {
  const root = mkdtempSync(join(tmpdir(), "cptr-assets-missing-"));
  try {
    const assets = loadWorkbenchAssets({
      cwd: root,
      moduleUrl: new URL("./dist/server/index.js", `file://${root}/`).href,
    });

    assert.equal(assets.ready, false);
    assert.equal(assets.directory, null);
    assert.match(assets.bundle, /bundle is not built/);
    assert.ok(assets.searchedDirectories.length >= 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("disables hot reload in production even when explicitly requested", () => {
  const defaultProduction = resolveWorkbenchHotReload(
    { bundle: "bundle-a", styles: "styles-a" },
    { NODE_ENV: "production" },
  );
  const forcedProduction = resolveWorkbenchHotReload(
    { bundle: "bundle-a", styles: "styles-a" },
    { NODE_ENV: "production", CPTR_HOT_RELOAD: "1" },
  );
  const changed = resolveWorkbenchHotReload(
    { bundle: "bundle-b", styles: "styles-a" },
    { NODE_ENV: "production" },
  );

  assert.equal(defaultProduction.enabled, false);
  assert.equal(forcedProduction.enabled, false);
  assert.equal(defaultProduction.buildId, forcedProduction.buildId);
  assert.notEqual(defaultProduction.buildId, changed.buildId);
  assert.match(defaultProduction.buildId, /^[a-f0-9]{24}$/);
});

test("defaults hot reload off when the runtime is not explicitly development", () => {
  const unclassifiedRuntime = resolveWorkbenchHotReload(
    { bundle: "bundle", styles: "styles" },
    {},
  );

  assert.equal(unclassifiedRuntime.enabled, false);
});

test("keeps hot reload available for development with an explicit opt-out", () => {
  const enabled = resolveWorkbenchHotReload(
    { bundle: "bundle", styles: "styles" },
    { NODE_ENV: "development", CPTR_WORKBENCH_BUILD_ID: "release 42" },
  );
  const disabled = resolveWorkbenchHotReload(
    { bundle: "bundle", styles: "styles" },
    { NODE_ENV: "development", CPTR_HOT_RELOAD: "0", CPTR_WORKBENCH_BUILD_ID: "release 42" },
  );

  assert.equal(enabled.enabled, true);
  assert.equal(disabled.enabled, false);
  assert.match(enabled.buildId, /^release-42-[a-f0-9]{24}$/);
});
