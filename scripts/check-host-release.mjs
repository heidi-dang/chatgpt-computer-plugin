import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const service = process.env.CPTR_SYSTEMD_UNIT?.trim();
const releaseRoot = process.env.CPTR_RELEASE_ROOT?.trim();
const expectedSha = process.env.CPTR_EXPECTED_RELEASE_SHA?.trim();
const releaseDropIn = process.env.CPTR_RELEASE_DROPIN_PATH?.trim();
const nodeBin = process.env.CPTR_NODE_BIN?.trim();

for (const [name, value] of [
  ["CPTR_SYSTEMD_UNIT", service],
  ["CPTR_RELEASE_ROOT", releaseRoot],
  ["CPTR_EXPECTED_RELEASE_SHA", expectedSha],
  ["CPTR_RELEASE_DROPIN_PATH", releaseDropIn],
  ["CPTR_NODE_BIN", nodeBin],
]) {
  if (!value) throw new Error(`${name} is required for the host-release gate`);
}
if (!/^[0-9a-f]{40}$/.test(expectedSha)) {
  throw new Error("CPTR_EXPECTED_RELEASE_SHA must be a full 40-character Git SHA");
}

function systemctl(property) {
  const result = spawnSync("systemctl", ["show", service, `--property=${property}`, "--value"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`systemctl show ${property} failed: ${(result.stderr || "unknown error").trim()}`);
  }
  return result.stdout.trim();
}

const expectedReleaseDir = realpathSync(resolve(releaseRoot, expectedSha));
const expectedDropInPath = realpathSync(releaseDropIn);
const workingDirectory = realpathSync(systemctl("WorkingDirectory"));
if (workingDirectory !== expectedReleaseDir) {
  throw new Error(`systemd WorkingDirectory drift: expected ${expectedReleaseDir}, got ${workingDirectory}`);
}

const execStart = systemctl("ExecStart");
if (!execStart.includes(`${expectedReleaseDir}/dist/server/index.js`)) {
  throw new Error(`systemd ExecStart does not point at the expected immutable release ${expectedReleaseDir}`);
}

const dropInPaths = systemctl("DropInPaths")
  .split(/\s+/)
  .filter(Boolean)
  .map((path) => realpathSync(path));
if (!dropInPaths.includes(expectedDropInPath)) {
  throw new Error(`canonical release drop-in is not active: ${expectedDropInPath}`);
}

const releaseAuthorityPattern = /^(?:WorkingDirectory|ExecStart|Environment=(?:NODE_ENV|CPTR_HOT_RELOAD|CPTR_WORKBENCH_BUILD_ID|GIT_COMMIT_SHA)=)/m;
const conflicting = [];
for (const path of dropInPaths) {
  const source = readFileSync(path, "utf8");
  if (path !== expectedDropInPath && releaseAuthorityPattern.test(source)) {
    conflicting.push(path);
  }
}
if (conflicting.length) {
  throw new Error(`multiple systemd drop-ins can control the release: ${conflicting.join(", ")}`);
}

const canonical = readFileSync(expectedDropInPath, "utf8");
for (const invariant of [
  `WorkingDirectory=${expectedReleaseDir}`,
  `ExecStart=${nodeBin} ${expectedReleaseDir}/dist/server/index.js`,
  "Environment=NODE_ENV=production",
  "Environment=CPTR_HOT_RELOAD=0",
  `Environment=CPTR_WORKBENCH_BUILD_ID=${expectedSha}`,
  `Environment=GIT_COMMIT_SHA=${expectedSha}`,
]) {
  if (!canonical.includes(invariant)) {
    throw new Error(`canonical release drop-in is missing invariant: ${invariant}`);
  }
}

const activeState = systemctl("ActiveState");
const subState = systemctl("SubState");
if (activeState !== "active" || subState !== "running") {
  throw new Error(`service is not active/running: ${activeState}/${subState}`);
}

console.log(`Host release verified: ${service} is active on immutable release ${expectedSha} with one release-authority drop-in.`);
