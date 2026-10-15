import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseArgs, qualifies, verifyCheckout } from "../scripts/release-guardian.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const goodSha = "a".repeat(40);
const flags = [
  "--plugin=plugin", "--backend=backend", "--extension=extension",
  "--plugin-sha=" + goodSha, "--backend-sha=" + goodSha,
  "--extension-sha=" + goodSha, "--output=out.json",
];

test("Release Guardian requires an exact pinned SHA tuple and an evidence destination", () => {
  assert.equal(parseArgs(flags)["plugin-sha"], goodSha);
  assert.throws(() => parseArgs(flags.filter((x) => !x.startsWith("--backend-sha"))), /backend-sha/);
  assert.throws(() => parseArgs(flags.map((x) => x.startsWith("--plugin-sha") ? "--plugin-sha=main" : x)), /release SHA/);
  assert.throws(() => parseArgs([...flags, "--plugin=other"]), /duplicate/);
  assert.throws(() => parseArgs([...flags, "--skip-tests=true"]), /invalid/);
  assert.throws(() => parseArgs([...flags, "--require-clean=anything"]), /require-clean/);
});

test("Release Guardian acceptance requires all five named passes with no skipped checks", () => {
  const names = ["browser-contract", "session-recovery", "typecheck", "full-regression", "production-build"];
  const evidence = {
    schema: "cptr.release-guardian.v1",
    identity: { plugin: goodSha, backend: goodSha, extension: goodSha },
    checks: names.map((name) => ({ name, status: "passed" })),
  };
  assert.equal(qualifies(evidence), true);
  for (const name of names) {
    assert.equal(qualifies({ ...evidence, checks: evidence.checks.filter((c) => c.name !== name) }), false);
    assert.equal(qualifies({ ...evidence, checks: evidence.checks.map((c) =>
      c.name === name ? { ...c, status: "skipped" } : c) }), false);
  }
  assert.equal(qualifies({ ...evidence, checks: [...evidence.checks.slice(0, 4), evidence.checks[0]] }), false);
});

test("Release Guardian rejects mismatched and nested repository roots", () => {
  const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  assert.equal(sha.status, 0);
  assert.equal(verifyCheckout("plugin", root, sha.stdout.trim()), realpathSync(root));
  assert.throws(() => verifyCheckout("plugin", root, goodSha), /exact-SHA mismatch/);
  assert.throws(() => verifyCheckout("plugin", new URL("../scripts/", import.meta.url).pathname, sha.stdout.trim()), /Git worktree root/);
});

test("manual release acceptance requires guardian and authenticated production evidence", () => {
  const workflow = readFileSync(new URL("../.github/workflows/production-qualification.yml", import.meta.url), "utf8");
  assert.match(workflow, /backend_release_sha:[\s\S]*?required: true/);
  assert.match(workflow, /extension_release_sha:[\s\S]*?required: true/);
  assert.match(workflow, /release-guardian:[\s\S]*?--require-clean=true/);
  assert.match(workflow, /needs\['release-guardian'\]\.result/);
  assert.match(workflow, /needs\['authenticated-contract'\]\.result/);
  assert.match(workflow, /needs\['managed-oauth-authenticated-contract'\]\.result/);
  assert.match(workflow, /actions\/upload-artifact@/);
});
