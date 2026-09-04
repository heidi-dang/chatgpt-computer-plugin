import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { ComputerClient } from "../server/client/computer-client.js";
import { McpActivityEmitter } from "../server/mcp-activity.js";
import { McpDiagnosticsEmitter } from "../server/mcp-diagnostics.js";
import { McpTrafficEmitter, normalizeMcpClient } from "../server/mcp-traffic.js";
import { createMcpServer, getMcpToolSurfaceProfile } from "../server/mcp.js";
import { StatelessServerPool } from "../server/stateless-server-pool.js";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function percentile(values: number[], quantile: number): number {
  const ordered = [...values].sort((a, b) => a - b);
  if (!ordered.length) return 0;
  const index = Math.max(0, Math.ceil(ordered.length * quantile) - 1);
  return ordered[Math.min(index, ordered.length - 1)] ?? 0;
}

async function telemetryScenario(flushMs: number) {
  const env = {
    CPTR_MCP_TRAFFIC_PLUGIN_BATCH_SIZE: "100",
    CPTR_MCP_TRAFFIC_PLUGIN_FLUSH_MS: String(flushMs),
    CPTR_MCP_TRAFFIC_PLUGIN_MAX_QUEUE: "1000",
    CPTR_MCP_ACTIVITY_PLUGIN_BATCH_SIZE: "100",
    CPTR_MCP_ACTIVITY_PLUGIN_FLUSH_MS: String(flushMs),
    CPTR_MCP_ACTIVITY_PLUGIN_MAX_QUEUE: "1000",
    CPTR_MCP_DIAGNOSTICS_PLUGIN_BATCH_SIZE: "100",
    CPTR_MCP_DIAGNOSTICS_PLUGIN_FLUSH_MS: String(flushMs),
    CPTR_MCP_DIAGNOSTICS_PLUGIN_MAX_QUEUE: "1000",
  };
  const deliveries = { traffic: 0, activity: 0, diagnostics: 0 };
  const traffic = new McpTrafficEmitter({ env, deliver: async () => { deliveries.traffic += 1; } });
  const activity = new McpActivityEmitter({ env, deliver: async () => { deliveries.activity += 1; } });
  const diagnostics = new McpDiagnosticsEmitter({ env, deliver: async () => { deliveries.diagnostics += 1; } });
  const client = normalizeMcpClient({ name: "ChatGPT", version: "benchmark" });

  const startedAt = performance.now();
  for (let index = 0; index < 10; index += 1) {
    traffic.sessionOpened(`benchmark-session-${index}`, client);
    activity.started({
      client,
      sessionId: `benchmark-session-${index}`,
      requestId: `request-${index}`,
      correlationId: `correlation-${index}`,
      toolName: "cptr_list_workspaces",
      title: "Benchmark",
      summary: "Synthetic benchmark activity",
      argumentsJson: "{}",
    });
    diagnostics.latency({
      request_id: `request-${index}`,
      correlation_id: `correlation-${index}`,
      edge_id: "client-mcp-connector",
      metric_type: "observed_request_time",
      duration_ms: 1,
      status: "ok",
      health_eligible: true,
    });
    await wait(100);
  }
  await wait(150);
  await Promise.all([traffic.close(), activity.close(), diagnostics.close()]);

  const dropped = traffic.stats().dropped + activity.stats().dropped + diagnostics.stats().dropped;
  return {
    flush_ms: flushMs,
    elapsed_ms: Math.round(performance.now() - startedAt),
    deliveries,
    total_deliveries: deliveries.traffic + deliveries.activity + deliveries.diagnostics,
    dropped,
  };
}

function profileToolSurface() {
  const client = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "benchmark-token",
    fetchImpl: async () => new Response("{}", { status: 200 }),
  });
  const samples: number[] = [];
  let lastProfile = null as ReturnType<typeof getMcpToolSurfaceProfile>;
  for (let index = 0; index < 25; index += 1) {
    const server = createMcpServer(client);
    const profile = getMcpToolSurfaceProfile(server);
    assert.ok(profile);
    samples.push(profile.registration_ms);
    lastProfile = profile;
  }
  assert.ok(lastProfile);

  const pool = new StatelessServerPool(() => createMcpServer(client), 2);
  const takeSamples: number[] = [];
  for (let index = 0; index < 25; index += 1) {
    const startedAt = performance.now();
    const item = pool.take();
    takeSamples.push(performance.now() - startedAt);
    assert.equal(item.pooled, true);
    pool.replenish();
  }
  const poolSnapshot = pool.snapshot();

  return {
    registered_tools: lastProfile.registered_tools,
    direct_tools: lastProfile.direct_tools,
    delegated_tools: lastProfile.delegated_tools,
    registration_p50_ms: Number(percentile(samples, 0.5).toFixed(3)),
    registration_p95_ms: Number(percentile(samples, 0.95).toFixed(3)),
    pooled_take_p95_ms: Number(percentile(takeSamples, 0.95).toFixed(3)),
    pool_hit_rate: poolSnapshot.hits / Math.max(1, poolSnapshot.hits + poolSnapshot.misses),
  };
}

const legacy = await telemetryScenario(250);
const current = await telemetryScenario(1000);
const surface = profileToolSurface();

assert.equal(legacy.dropped, 0);
assert.equal(current.dropped, 0);
assert.ok(current.total_deliveries < legacy.total_deliveries, "1s batching must reduce delivery/write pressure");
assert.equal(surface.registered_tools, 90);
assert.equal(surface.pool_hit_rate, 1);
assert.ok(surface.pooled_take_p95_ms < surface.registration_p95_ms || surface.registration_p95_ms === 0);

console.log(JSON.stringify({
  ok: true,
  telemetry: {
    legacy_250ms: legacy,
    current_1000ms: current,
    delivery_reduction_fraction: Number((1 - current.total_deliveries / legacy.total_deliveries).toFixed(4)),
  },
  tool_surface: surface,
}, null, 2));
