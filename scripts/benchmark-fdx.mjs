#!/usr/bin/env node
// Read-only FDX retrieval baseline. Measures total fresh-process CLI latency,
// not ChatGPT MCP round trips. No shell interpolation or repository writes.
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const query = process.argv[3] ?? "workbench";
const n = Number(process.argv[4] ?? "5");
if (!existsSync(root) || !statSync(root).isDirectory()
  || !Number.isInteger(n) || n < 1 || n > 30
  || query.length < 1 || query.length > 120) {
  console.error("Usage: node scripts/benchmark-fdx.mjs REPO_ROOT [SYMBOL_QUERY] [ITERATIONS=5, 1..30]");
  process.exitCode = 64;
} else {
  const bin = process.env.FDX_BIN ?? "fdx";
  const probes = [
    { name: "index-status", args: ["index", "status"] },
    { name: "symbol-search", args: ["search", query, "--max-matches", "10"] },
  ];
  let failed = false;
  const records = [];
  for (const probe of probes) {
    const values = [];
    for (let i = 0; i < n + 1; i += 1) {
      const start = process.hrtime.bigint();
      const result = spawnSync(bin, probe.args, {
        cwd: root,
        encoding: "utf8",
        timeout: 20_000,
        maxBuffer: 256 * 1024,
        env: { ...process.env },
      });
      const milliseconds = Number(process.hrtime.bigint() - start) / 1e6;
      if (result.error || result.status !== 0) {
        console.error(`${probe.name}: exit=${result.status}, error=${result.error?.message ?? result.stderr?.slice(0, 250) ?? "unknown"}`);
        failed = true;
        break;
      }
      if (i) values.push(milliseconds); // first run is a process/cache warm-up
    }
    if (values.length === n) {
      values.sort((a, b) => a - b);
      const q = (pct) => values[Math.ceil((pct / 100) * values.length) - 1];
      records.push({
        probe: probe.name, samples: n,
        p50_ms: Number(q(50).toFixed(2)),
        p95_ms: Number(q(95).toFixed(2)),
        min_ms: Number(values[0].toFixed(2)),
        max_ms: Number(values.at(-1).toFixed(2)),
      });
    }
  }
  console.log(JSON.stringify({ fdx: bin, root, query, metrics: records, valid: !failed }, null, 2));
  if (failed) process.exitCode = 1;
}
