import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const sourceEdge = readFileSync(
  new URL("../.github/workflows/production-qualification.yml", import.meta.url), "utf8",
);
const authenticated = readFileSync(
  new URL("../.github/workflows/managed-oauth-release-acceptance.yml", import.meta.url), "utf8",
);

test("routine source and edge qualification does not execute Managed OAuth bearer checks", () => {
  assert.match(sourceEdge, /source-edge-readiness:/);
  assert.match(sourceEdge, /NOT authenticated release acceptance/);
  assert.match(sourceEdge, /Managed OAuth authenticated MCP contract: NOT TESTED/);
  assert.match(sourceEdge, /needs\['release-guardian'\]\.result/);
  assert.match(sourceEdge, /needs\['public-edge'\]\.result/);
  assert.doesNotMatch(sourceEdge, /managed-oauth-authenticated-contract:/);
  assert.doesNotMatch(sourceEdge, /CPTR_MANAGED_OAUTH_ACCESS_TOKEN/);
  assert.doesNotMatch(sourceEdge, /run_managed_oauth_contract/);
  assert.doesNotMatch(sourceEdge, /Manual exact-SHA release acceptance/);
});

test("native-mode CI still requires successful authenticated contract and rejects unknown modes", () => {
  assert.match(sourceEdge, /vars\.CPTR_EDGE_AUTH_MODE == 'native'/);
  assert.match(sourceEdge, /needs\['authenticated-contract'\]\.result/);
  assert.match(sourceEdge, /native\)[\s\S]*?test "\$NATIVE_CONTRACT_RESULT" = "success"/);
  assert.match(sourceEdge, /cloudflare-managed\)[\s\S]*?test "\$NATIVE_CONTRACT_RESULT" = "skipped"/);
  assert.match(sourceEdge, /Unsupported production edge auth mode/);
});

test("dedicated manual Managed OAuth acceptance checks exact SHA and all three evidence gates", () => {
  assert.match(authenticated, /workflow_dispatch:/);
  assert.doesNotMatch(authenticated, /\n  schedule:/);
  assert.match(authenticated, /managed-oauth-authenticated-contract:/);
  assert.match(authenticated, /EDGE_AUTH_MODE:[^\n]+CPTR_EDGE_AUTH_MODE/);
  assert.match(authenticated, /test "\$EDGE_AUTH_MODE" = "cloudflare-managed"/);
  assert.match(authenticated, /CPTR_DEPLOYED_MCP_TOKEN: \$\{\{ secrets\.CPTR_MANAGED_OAUTH_ACCESS_TOKEN \}\}/);
  assert.doesNotMatch(authenticated, /CPTR_DEPLOYED_MCP_TOKEN: \$\{\{ secrets\.CPTR_DEPLOYED_MCP_TOKEN \}\}/);
  assert.match(authenticated, /ref: \$\{\{ inputs\.expected_release_sha \}\}/);
  assert.match(authenticated, /run: npm run check:deployed-contract/);
  assert.match(authenticated, /--require-clean=true/);
  assert.match(authenticated, /test "\$PUBLIC_RESULT" = "success"/);
  assert.match(authenticated, /test "\$GUARDIAN_RESULT" = "success"/);
  assert.match(authenticated, /test "\$AUTH_RESULT" = "success"/);
  assert.match(authenticated, /actions\/upload-artifact@/);
});

test("readiness mode selection fails closed for native failures and unsupported modes", () => {
  const caseScript = sourceEdge.match(/          case "\$EDGE_AUTH_MODE" in[\s\S]*?          esac/)?.[0];
  assert.ok(caseScript, "source/edge mode gate must exist");
  const invoke = (mode: string, result: string) => spawnSync("bash", ["-e", "-c", caseScript], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, EDGE_AUTH_MODE: mode, NATIVE_CONTRACT_RESULT: result },
  });
  assert.equal(invoke("native", "success").status, 0);
  assert.notEqual(invoke("native", "failure").status, 0);
  assert.notEqual(invoke("native", "skipped").status, 0);
  assert.equal(invoke("cloudflare-managed", "skipped").status, 0);
  assert.notEqual(invoke("cloudflare-managed", "success").status, 0);
  assert.notEqual(invoke("unknown", "skipped").status, 0);
});

test("manual Managed OAuth acceptance fails closed unless public, Guardian and auth all succeed", () => {
  const script = authenticated.match(/          test "\$EDGE_AUTH_MODE" = "cloudflare-managed"\n          test "\$PUBLIC_RESULT" = "success"\n          test "\$GUARDIAN_RESULT" = "success"\n          test "\$AUTH_RESULT" = "success"/)?.[0];
  assert.ok(script, "manual acceptance must require all three successful checks");
  const invoke = (mode: string, publicResult: string, guardianResult: string, authResult: string) =>
    spawnSync("bash", ["-e", "-c", script], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH, EDGE_AUTH_MODE: mode,
        PUBLIC_RESULT: publicResult, GUARDIAN_RESULT: guardianResult, AUTH_RESULT: authResult,
      },
    });
  assert.equal(invoke("cloudflare-managed", "success", "success", "success").status, 0);
  assert.notEqual(invoke("cloudflare-managed", "failure", "success", "success").status, 0);
  assert.notEqual(invoke("cloudflare-managed", "success", "skipped", "success").status, 0);
  assert.notEqual(invoke("cloudflare-managed", "success", "success", "failure").status, 0);
  assert.notEqual(invoke("native", "success", "success", "success").status, 0);
});
