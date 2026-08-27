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

test("enables production-safe hot reload by default and fingerprints the deployed assets", () => {
  const first = resolveWorkbenchHotReload(
    { bundle: "bundle-a", styles: "styles-a" },
    { NODE_ENV: "production" },
  );
  const same = resolveWorkbenchHotReload(
    { bundle: "bundle-a", styles: "styles-a" },
    { NODE_ENV: "production" },
  );
  const changed = resolveWorkbenchHotReload(
    { bundle: "bundle-b", styles: "styles-a" },
    { NODE_ENV: "production" },
  );

  assert.equal(first.enabled, true);
  assert.equal(first.buildId, same.buildId);
  assert.notEqual(first.buildId, changed.buildId);
  assert.match(first.buildId, /^[a-f0-9]{24}$/);
});

test("supports explicit hot-reload disable and release-labelled asset fingerprints", () => {
  const disabled = resolveWorkbenchHotReload(
    { bundle: "bundle", styles: "styles" },
    { CPTR_HOT_RELOAD: "0", CPTR_WORKBENCH_BUILD_ID: "release 42" },
  );
  const enabled = resolveWorkbenchHotReload(
    { bundle: "bundle", styles: "styles" },
    { CPTR_HOT_RELOAD: "1", CPTR_WORKBENCH_BUILD_ID: "release 42" },
  );

  assert.equal(disabled.enabled, false);
  assert.equal(enabled.enabled, true);
  assert.match(enabled.buildId, /^release-42-[a-f0-9]{24}$/);
});
