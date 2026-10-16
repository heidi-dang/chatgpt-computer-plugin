#!/usr/bin/env node
// Fail-closed qualification of one immutable plugin/backend/extension release tuple.
// This verifies candidate source and local regressions. The authenticated deployed
// MCP check remains a separate, mandatory production-acceptance gate.
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const allowed = new Set(["plugin", "backend", "extension", "plugin-sha", "backend-sha", "extension-sha", "output", "require-clean"]);
const required = ["plugin", "backend", "extension", "plugin-sha", "backend-sha", "extension-sha", "output"];
const shaPattern = /^[0-9a-f]{40}$/;

export function parseArgs(argv) {
  const args = Object.create(null);
  for (const raw of argv) {
    const match = /^--([a-z-]+)=(.*)$/.exec(raw);
    if (!match || !allowed.has(match[1]) || Object.hasOwn(args, match[1])) {
      throw new Error("invalid or duplicate Release Guardian argument");
    }
    args[match[1]] = match[2];
  }
  for (const key of required) {
    if (!args[key]) throw new Error("Release Guardian requires --" + key);
  }
  for (const name of ["plugin", "backend", "extension"]) {
    if (!shaPattern.test(args[name + "-sha"])) throw new Error("invalid " + name + " release SHA");
  }
  if (args["require-clean"] !== undefined && args["require-clean"] !== "true" && args["require-clean"] !== "false") {
    throw new Error("--require-clean must be true or false");
  }
  return args;
}

function execute(binary, params, options = {}) {
  const result = spawnSync(binary, params, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: "utf8",
    timeout: options.timeout || 30_000,
    maxBuffer: 4 * 1024 * 1024,
    shell: false,
  });
  return {
    success: !result.error && result.status === 0 && !result.signal,
    exitCode: result.status,
    reason: result.error?.code || result.signal || null,
    fingerprint: createHash("sha256").update((result.stdout || "") + "\n" + (result.stderr || "")).digest("hex"),
    durationMs: 0,
  };
}

export function verifyCheckout(name, repo, sha, requireClean = false) {
  const root = realpathSync(resolve(repo));
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" });
  if (top.status !== 0 || realpathSync(top.stdout.trim()) !== root) throw new Error(name + ": not a Git worktree root");
  const actual = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (actual.status !== 0 || actual.stdout.trim() !== sha) throw new Error(name + ": exact-SHA mismatch");
  if (requireClean) {
    const dirty = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=normal"], { cwd: root, encoding: "utf8" });
    if (dirty.status !== 0 || dirty.stdout.trim()) throw new Error(name + ": checkout is not clean");
  }
  return root;
}

export function qualifies(evidence) {
  return evidence?.schema === "cptr.release-guardian.v1"
    && evidence?.identity?.plugin && evidence?.identity?.backend && evidence?.identity?.extension
    && Array.isArray(evidence.checks)
    && evidence.checks.length === 5
    && new Set(evidence.checks.map((check) => check.name)).size === 5
    && ["browser-contract", "session-recovery", "typecheck", "full-regression", "production-build"]
      .every((name) => evidence.checks.some((check) => check.name === name && check.status === "passed"));
}

const checks = [
  ["browser-contract", "node", ["scripts/check-cross-repo-browser-contract.mjs"]],
  ["session-recovery", "node", ["--import", "tsx", "--test",
    "tests/live-ticket-recovery.test.ts", "tests/prompt-ticket-recovery.test.ts",
    "tests/stateless-live-binding.test.ts", "tests/workbench.test.ts",
    "tests/live-gateway.test.ts", "tests/browser-device-proxy.test.ts",
    "tests/oauth-state.test.ts", "tests/terminal-parity.test.ts"]],
  ["typecheck", "npm", ["run", "typecheck"]],
  ["full-regression", "npm", ["test"]],
  ["production-build", "npm", ["run", "build"]],
];

export function runGuardian(args) {
  const output = resolve(args.output);
  const evidence = {
    schema: "cptr.release-guardian.v1",
    generatedAt: new Date().toISOString(),
    identity: { plugin: args["plugin-sha"], backend: args["backend-sha"], extension: args["extension-sha"] },
    checks: [],
    status: "failed",
  };
  try {
    const repo = Object.fromEntries(["plugin", "backend", "extension"].map((name) => [
      name, verifyCheckout(name, args[name], evidence.identity[name], args["require-clean"] === "true"),
    ]));
    const packageJson = JSON.parse(readFileSync(resolve(repo.plugin, "package.json"), "utf8"));
    if (typeof packageJson.version !== "string" || !/^\d+\.\d+\.\d+$/.test(packageJson.version)) {
      throw new Error("plugin package version is missing or malformed");
    }
    evidence.pluginVersion = packageJson.version;
    for (const [name, binary, params] of checks) {
      const started = performance.now();
      const r = execute(binary, params, {
        cwd: repo.plugin,
        env: { ...process.env, CPTR_BACKEND_REPO: repo.backend, CPTR_EXTENSION_REPO: repo.extension },
        timeout: 12 * 60_000,
      });
      r.durationMs = Math.round(performance.now() - started);
      evidence.checks.push({
        name, status: r.success ? "passed" : "failed",
        exitCode: r.exitCode, reason: r.reason, outputSha256: r.fingerprint, durationMs: r.durationMs,
      });
      process.stdout.write("[Release Guardian] " + name + ": " + (r.success ? "passed" : "FAILED") + " (" + r.durationMs + "ms)\n");
    }
    evidence.status = qualifies(evidence) ? "passed" : "failed";
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : "unknown qualification error";
    process.stderr.write("[Release Guardian] " + evidence.error + "\n");
  } finally {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
    if (process.env.GITHUB_STEP_SUMMARY) {
      const rows = evidence.checks.map((x) => "| " + x.name + " | " + x.status + " | " + x.durationMs + " |").join("\n");
      appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        "### Release Guardian: " + evidence.status + "\n\n"
        + "Pinned tuple: " + Object.values(evidence.identity).map((sha) => "\`" + sha + "\`").join(" / ") + "\n\n"
        + "| Check | Result | Duration (ms) |\n|---|---|---:|\n" + rows + "\n");
    }
  }
  return evidence;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = runGuardian(parseArgs(process.argv.slice(2)));
    if (!qualifies(result)) process.exitCode = 1;
  } catch (error) {
    process.stderr.write("[Release Guardian] " + (error instanceof Error ? error.message : "invalid invocation") + "\n");
    process.exitCode = 1;
  }
}
