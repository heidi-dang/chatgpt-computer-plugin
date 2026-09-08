import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(
  new URL("../.github/workflows/production-qualification.yml", import.meta.url),
  "utf8",
);

test("manual production qualification fails closed unless the selected authenticated contract passes", () => {
  assert.match(
    workflow,
    /run_managed_oauth_contract:[\s\S]*?default: true/,
  );
  assert.match(workflow, /manual-release-acceptance:/);
  assert.match(
    workflow,
    /if: \$\{\{ always\(\) && github\.event_name == 'workflow_dispatch' \}\}/,
  );
  assert.match(workflow, /needs\['public-edge'\]\.result/);
  assert.match(workflow, /needs\['authenticated-contract'\]\.result/);
  assert.match(workflow, /needs\['managed-oauth-authenticated-contract'\]\.result/);
  assert.match(
    workflow,
    /cloudflare-managed\)[\s\S]*?test "\$RUN_MANAGED_OAUTH_CONTRACT" = "true"[\s\S]*?test "\$MANAGED_CONTRACT_RESULT" = "success"/,
  );
  assert.match(
    workflow,
    /native\)[\s\S]*?test "\$NATIVE_CONTRACT_RESULT" = "success"/,
  );
});
