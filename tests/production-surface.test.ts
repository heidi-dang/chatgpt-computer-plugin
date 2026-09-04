import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serverSource = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
const deployedContractSource = readFileSync(new URL("../scripts/check-deployed-contract.mjs", import.meta.url), "utf8");

test("production health response does not expose internal workbench filesystem paths", () => {
  const healthBlock = serverSource.match(/if \(url\.pathname === "\/health"\) \{([\s\S]*?)\n  \}/)?.[1] ?? "";

  assert.notEqual(healthBlock, "", "health route must remain present");
  assert.doesNotMatch(healthBlock, /asset_directory|assets\.directory|searchedDirectories|active_sessions|session_mode|hot_reload/);
  assert.match(healthBlock, /ready: assets\.ready/);
  assert.match(healthBlock, /build_id: reload\.buildId/);
});

test("deployed contract verifier rejects public development routes and leaked health paths", () => {
  assert.match(deployedContractSource, /asset_directory/);
  assert.match(deployedContractSource, /\/__cptr\/dev\/workbench\.js/);
  assert.match(deployedContractSource, /\/__cptr\/dev\/workbench\.css/);
  assert.match(deployedContractSource, /\/__cptr\/dev\/reload/);
  assert.match(deployedContractSource, /development route unexpectedly exposed/);
});

test("MCP authentication advertises canonical RFC 9728 metadata and native OAuth discovery", () => {
  assert.match(serverSource, /protectedResourceMetadataPath\(mcpPath\)/);
  assert.match(serverSource, /createBearerChallenge\(metadataUrl, advertisedOauthScopes\)/);
  assert.match(serverSource, /url\.pathname === oauthProtectedResourcePath/);
  assert.match(serverSource, /url\.pathname === oauthRootProtectedResourcePath/);
  assert.match(serverSource, /url\.pathname === "\/\.well-known\/oauth-authorization-server"/);
  assert.match(serverSource, /url\.pathname === "\/oauth\/authorize"/);
  assert.match(serverSource, /url\.pathname === "\/oauth\/token"/);
  assert.match(serverSource, /url\.pathname === "\/oauth\/register"/);
  assert.match(serverSource, /url\.pathname === "\/oauth\/login"/);
});
