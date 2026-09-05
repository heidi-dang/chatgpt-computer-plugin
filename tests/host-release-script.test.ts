import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../scripts/check-host-release.mjs", import.meta.url), "utf8");

test("host release gate rejects deployment-owned metadata in the durable service environment file", () => {
  assert.match(source, /CPTR_SERVICE_ENV_FILE/);
  assert.match(source, /GIT_COMMIT_SHA/);
  assert.match(source, /CPTR_WORKBENCH_BUILD_ID/);
  assert.match(source, /NODE_ENV/);
  assert.match(source, /CPTR_HOT_RELOAD/);
  assert.match(source, /must not define release-owned keys/);
});
