import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { ComputerClient } from "../server/client/computer-client.js";

const TERMINAL_COMMAND_STATUSES = new Set([
  "COMPLETE",
  "COMPLETE_WITH_TOOL_ERRORS",
  "FAILED",
  "CANCELLED",
]);

type JsonRecord = Record<string, unknown>;

type LifecycleSample = {
  start_response_latency_ms: number;
  completion_after_start_ms: number;
  operation_latency_ms: number;
  cleanup_latency_ms: number;
  total_latency_ms: number;
  plugin_cpu_ms: number;
  plugin_rss_delta_bytes: number;
  plugin_heap_delta_bytes: number;
  backend_cpu_ms: number | null;
  backend_rss_delta_bytes: number | null;
  backend_phase_ms: Record<string, number>;
  status_polls: number;
  cleanup_polls: number;
  cleanup_converged: boolean;
};

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function numberAt(value: unknown, path: string[]): number | null {
  let current: unknown = value;
  for (const key of path) current = record(current)[key];
  return typeof current === "number" && Number.isFinite(current) ? current : null;
}

function booleanAt(value: unknown, path: string[]): boolean | null {
  let current: unknown = value;
  for (const key of path) current = record(current)[key];
  return typeof current === "boolean" ? current : null;
}

function percentile(values: number[], quantile: number): number {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * quantile) - 1));
  return ordered[index] ?? 0;
}

function distribution(values: number[]) {
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    samples: values.length,
    min: Number(Math.min(...values).toFixed(3)),
    p50: Number(percentile(values, 0.50).toFixed(3)),
    p95: Number(percentile(values, 0.95).toFixed(3)),
    p99: Number(percentile(values, 0.99).toFixed(3)),
    max: Number(Math.max(...values).toFixed(3)),
    mean: Number((total / Math.max(1, values.length)).toFixed(3)),
  };
}

function summarize(samples: LifecycleSample[]) {
  const backendCpu = samples.flatMap((sample) => sample.backend_cpu_ms === null ? [] : [sample.backend_cpu_ms]);
  const backendRss = samples.flatMap((sample) => sample.backend_rss_delta_bytes === null ? [] : [sample.backend_rss_delta_bytes]);
  const phaseNames = [...new Set(samples.flatMap((sample) => Object.keys(sample.backend_phase_ms)))].sort();
  const backendPhases = Object.fromEntries(
    phaseNames.map((name) => [
      name,
      distribution(samples.flatMap((sample) => typeof sample.backend_phase_ms[name] === "number" ? [sample.backend_phase_ms[name]] : [])),
    ]),
  );
  return {
    start_response_latency_ms: distribution(samples.map((sample) => sample.start_response_latency_ms)),
    completion_after_start_ms: distribution(samples.map((sample) => sample.completion_after_start_ms)),
    operation_latency_ms: distribution(samples.map((sample) => sample.operation_latency_ms)),
    cleanup_latency_ms: distribution(samples.map((sample) => sample.cleanup_latency_ms)),
    total_latency_ms: distribution(samples.map((sample) => sample.total_latency_ms)),
    plugin_cpu_ms: distribution(samples.map((sample) => sample.plugin_cpu_ms)),
    plugin_rss_delta_bytes: distribution(samples.map((sample) => sample.plugin_rss_delta_bytes)),
    plugin_heap_delta_bytes: distribution(samples.map((sample) => sample.plugin_heap_delta_bytes)),
    backend_cpu_ms: backendCpu.length ? distribution(backendCpu) : null,
    backend_rss_delta_bytes: backendRss.length ? distribution(backendRss) : null,
    backend_phase_ms: backendPhases,
    status_polls: distribution(samples.map((sample) => sample.status_polls)),
    cleanup: {
      converged: samples.filter((sample) => sample.cleanup_converged).length,
      failed: samples.filter((sample) => !sample.cleanup_converged).length,
      max_polls: Math.max(0, ...samples.map((sample) => sample.cleanup_polls)),
    },
  };
}

function commandCounts(snapshot: JsonRecord) {
  return {
    active: numberAt(snapshot, ["commands", "active"]) ?? 0,
    launching: numberAt(snapshot, ["commands", "launching"]) ?? 0,
    capacity_used: numberAt(snapshot, ["commands", "capacity_used"]) ?? 0,
    completed_retained: numberAt(snapshot, ["commands", "completed_retained"]) ?? 0,
  };
}

function browserCounts(snapshot: JsonRecord) {
  return {
    active_sessions: numberAt(snapshot, ["browser_device", "active_sessions"]) ?? 0,
    active_leases: numberAt(snapshot, ["browser_device", "active_leases"]) ?? 0,
    connected_devices: numberAt(snapshot, ["browser_device", "connected_devices"]) ?? 0,
  };
}

async function waitForCommandCleanup(
  client: ComputerClient,
  baseline: ReturnType<typeof commandCounts>,
): Promise<{ snapshot: JsonRecord; polls: number; converged: boolean }> {
  let snapshot = await client.getRuntimeMetrics();
  for (let polls = 1; polls <= 8; polls += 1) {
    const current = commandCounts(snapshot);
    if (current.active === baseline.active && current.launching === baseline.launching) {
      return { snapshot, polls, converged: true };
    }
    snapshot = await client.getRuntimeMetrics();
  }
  return { snapshot, polls: 8, converged: false };
}

async function waitForBrowserCleanup(
  client: ComputerClient,
  baseline: ReturnType<typeof browserCounts>,
): Promise<{ snapshot: JsonRecord; polls: number; converged: boolean }> {
  let snapshot = await client.getRuntimeMetrics();
  for (let polls = 1; polls <= 8; polls += 1) {
    const current = browserCounts(snapshot);
    if (
      current.active_sessions === baseline.active_sessions &&
      current.active_leases === baseline.active_leases
    ) {
      return { snapshot, polls, converged: true };
    }
    snapshot = await client.getRuntimeMetrics();
  }
  return { snapshot, polls: 8, converged: false };
}

function resourceSample(
  startedAt: number,
  startResponseAt: number,
  operationCompletedAt: number,
  cleanupCompletedAt: number,
  cpuBefore: NodeJS.CpuUsage,
  memoryBefore: NodeJS.MemoryUsage,
  backendBefore: JsonRecord,
  backendAfter: JsonRecord,
  backendPhaseMs: Record<string, number>,
  statusPolls: number,
  cleanup: { polls: number; converged: boolean },
): LifecycleSample {
  const memoryAfter = process.memoryUsage();
  const cpu = process.cpuUsage(cpuBefore);
  const backendCpuBefore = numberAt(backendBefore, ["runtime", "process", "cpu_seconds"]);
  const backendCpuAfter = numberAt(backendAfter, ["runtime", "process", "cpu_seconds"]);
  const backendRssBefore = numberAt(backendBefore, ["runtime", "process", "rss_bytes"]);
  const backendRssAfter = numberAt(backendAfter, ["runtime", "process", "rss_bytes"]);
  return {
    start_response_latency_ms: startResponseAt - startedAt,
    completion_after_start_ms: operationCompletedAt - startResponseAt,
    operation_latency_ms: operationCompletedAt - startedAt,
    cleanup_latency_ms: cleanupCompletedAt - operationCompletedAt,
    total_latency_ms: cleanupCompletedAt - startedAt,
    plugin_cpu_ms: (cpu.user + cpu.system) / 1000,
    plugin_rss_delta_bytes: memoryAfter.rss - memoryBefore.rss,
    plugin_heap_delta_bytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
    backend_cpu_ms:
      backendCpuBefore === null || backendCpuAfter === null
        ? null
        : Math.max(0, (backendCpuAfter - backendCpuBefore) * 1000),
    backend_rss_delta_bytes:
      backendRssBefore === null || backendRssAfter === null
        ? null
        : backendRssAfter - backendRssBefore,
    backend_phase_ms: backendPhaseMs,
    status_polls: statusPolls,
    cleanup_polls: cleanup.polls,
    cleanup_converged: cleanup.converged,
  };
}

async function measureCommand(
  client: ComputerClient,
  workspaceId: string,
  command: string,
  iteration: number,
  useIdempotency: boolean,
): Promise<LifecycleSample> {
  const backendBefore = await client.getRuntimeMetrics();
  const baseline = commandCounts(backendBefore);
  const cpuBefore = process.cpuUsage();
  const memoryBefore = process.memoryUsage();
  const startedAt = performance.now();
  let result = await client.runCodingCommand({
    workspace_id: workspaceId,
    command,
    wait_seconds: 0,
    allow_network: false,
    measure_lifecycle: true,
    ...(useIdempotency ? { idempotency_key: `runtime-benchmark-${process.pid}-${iteration}-${randomUUID()}` } : {}),
  });
  const startResponseAt = performance.now();
  let offset = result.next_offset ?? 0;
  let statusPolls = 0;
  while (!TERMINAL_COMMAND_STATUSES.has(result.status.toUpperCase())) {
    statusPolls += 1;
    result = await client.getCodingCommand({
      workspace_id: workspaceId,
      command_id: result.command_id,
      offset,
      wait_seconds: 1,
      tail_bytes: 0,
    });
    offset = result.next_offset ?? offset;
  }
  if (result.status.toUpperCase() !== "COMPLETE" || result.exit_code !== 0) {
    throw new Error(`benchmark command failed: status=${result.status} exit_code=${String(result.exit_code)}`);
  }
  const operationCompletedAt = performance.now();
  const backendPhaseMs = Object.fromEntries(
    Object.entries(result.lifecycle_timing_ms ?? {}).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]),
    ),
  );
  const cleanup = await waitForCommandCleanup(client, baseline);
  const cleanupCompletedAt = performance.now();
  return resourceSample(
    startedAt,
    startResponseAt,
    operationCompletedAt,
    cleanupCompletedAt,
    cpuBefore,
    memoryBefore,
    backendBefore,
    cleanup.snapshot,
    backendPhaseMs,
    statusPolls,
    cleanup,
  );
}

async function measureBrowserCycle(
  client: ComputerClient,
  deviceId: string,
  tabId: number,
  iteration: number,
): Promise<LifecycleSample> {
  const backendBefore = await client.getRuntimeMetrics();
  const baseline = browserCounts(backendBefore);
  const cpuBefore = process.cpuUsage();
  const memoryBefore = process.memoryUsage();
  const startedAt = performance.now();
  let sessionId: string | null = null;
  let epoch: number | null = null;
  let released = false;
  try {
    const opened = await client.controlUserChrome({ action: "open_session", device_id: deviceId, tab_id: tabId });
    sessionId = typeof opened.session_id === "string" ? opened.session_id : null;
    const lease = record(opened.lease);
    epoch = typeof lease.epoch === "number" ? lease.epoch : null;
    if (!sessionId || epoch === null) throw new Error("browser benchmark session did not return an agent lease");
    await client.controlUserChrome({
      action: "command",
      session_id: sessionId,
      command_id: `runtime-status-${iteration}-${randomUUID()}`,
      browser_action: "status",
      wait_seconds: 15,
    });
    await client.controlUserChrome({
      action: "transfer_lease",
      session_id: sessionId,
      expected_epoch: epoch,
      expected_owner: "agent",
      new_owner: "none",
    });
    released = true;
  } finally {
    if (sessionId && epoch !== null && !released) {
      await client.controlUserChrome({
        action: "transfer_lease",
        session_id: sessionId,
        expected_epoch: epoch,
        expected_owner: "agent",
        new_owner: "none",
      }).catch(() => undefined);
    }
  }
  const operationCompletedAt = performance.now();
  const cleanup = await waitForBrowserCleanup(client, baseline);
  const cleanupCompletedAt = performance.now();
  return resourceSample(
    startedAt,
    operationCompletedAt,
    operationCompletedAt,
    cleanupCompletedAt,
    cpuBefore,
    memoryBefore,
    backendBefore,
    cleanup.snapshot,
    {},
    0,
    cleanup,
  );
}

async function measureMetricsProbe(client: ComputerClient, samples: number) {
  const durations: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const startedAt = performance.now();
    await client.getRuntimeMetrics();
    durations.push(performance.now() - startedAt);
  }
  return distribution(durations);
}

async function main() {
  const baseUrl = process.env.CPTR_BASE_URL?.trim();
  const token = process.env.CPTR_API_TOKEN?.trim();
  if (!baseUrl || !token) throw new Error("CPTR_BASE_URL and CPTR_API_TOKEN are required");

  const iterations = boundedInt(process.env.CPTR_RUNTIME_BENCH_ITERATIONS, 20, 5, 100);
  const warmups = boundedInt(process.env.CPTR_RUNTIME_BENCH_WARMUPS, 3, 0, 20);
  const browserIterations = boundedInt(process.env.CPTR_RUNTIME_BROWSER_ITERATIONS, 3, 1, 20);
  const metricsProbes = boundedInt(process.env.CPTR_RUNTIME_METRICS_PROBES, 20, 5, 100);
  const useIdempotency = process.env.CPTR_RUNTIME_BENCH_IDEMPOTENCY !== "0";
  const command = process.env.CPTR_RUNTIME_BENCH_COMMAND?.trim() || "python -c \"print('cptr-runtime-benchmark')\"";
  const client = new ComputerClient({ baseUrl, token, timeoutMs: 60_000 });
  const workspaces = (await client.listWorkspaces(false)).workspaces;
  const configuredWorkspace = process.env.CPTR_RUNTIME_BENCH_WORKSPACE_ID?.trim();
  const workspace = configuredWorkspace
    ? workspaces.find((item) => item.workspace_id === configuredWorkspace)
    : workspaces.find((item) => item.available !== false);
  if (!workspace) throw new Error("no available CPTR workspace is available for the runtime benchmark");

  const initialBackend = await client.getRuntimeMetrics();
  const pluginStart = process.memoryUsage();
  const metricsProbe = await measureMetricsProbe(client, metricsProbes);

  for (let index = 0; index < warmups; index += 1) {
    await measureCommand(client, workspace.workspace_id, command, -index - 1, useIdempotency);
  }
  const commandSamples: LifecycleSample[] = [];
  for (let index = 0; index < iterations; index += 1) {
    commandSamples.push(await measureCommand(client, workspace.workspace_id, command, index, useIdempotency));
  }

  let browser: JsonRecord;
  const deviceResult = await client.controlUserChrome({ action: "list_devices" }).catch(() => ({ devices: [] }));
  const devices = Array.isArray(deviceResult.devices) ? deviceResult.devices.map(record) : [];
  const connected = devices.find((device) => booleanAt(device, ["connected"]) === true && typeof device.device_id === "string");
  if (!connected || typeof connected.device_id !== "string") {
    browser = { status: "skipped", reason: "no connected paired Chrome device" };
  } else {
    const tabsResult = await client.controlUserChrome({ action: "list_tabs", device_id: connected.device_id });
    const tabs = Array.isArray(tabsResult.tabs) ? tabsResult.tabs.map(record) : [];
    const tab = tabs.find((item) => item.active === true && Number.isSafeInteger(item.id)) ?? tabs.find((item) => Number.isSafeInteger(item.id));
    if (!tab || typeof tab.id !== "number") {
      browser = { status: "skipped", reason: "connected Chrome device has no discoverable tab" };
    } else {
      const samples: LifecycleSample[] = [];
      for (let index = 0; index < browserIterations; index += 1) {
        samples.push(await measureBrowserCycle(client, connected.device_id, tab.id, index));
      }
      browser = { status: "measured", iterations: samples.length, summary: summarize(samples), samples };
    }
  }

  const finalBackend = await client.getRuntimeMetrics();
  const pluginEnd = process.memoryUsage();
  const report = {
    ok:
      commandSamples.every((sample) => sample.cleanup_converged) &&
      (browser.status !== "measured" || (record(browser.summary).cleanup as JsonRecord | undefined)?.failed === 0),
    version: 1,
    workspace: { workspace_id: workspace.workspace_id, name: workspace.name },
    config: { iterations, warmups, browser_iterations: browserIterations, metrics_probes: metricsProbes, idempotency: useIdempotency },
    instrumentation: { runtime_metrics_rtt_ms: metricsProbe },
    terminal: {
      iterations: commandSamples.length,
      summary: summarize(commandSamples),
      samples: commandSamples,
    },
    browser,
    baseline: {
      backend: initialBackend,
      plugin: { rss_bytes: pluginStart.rss, heap_used_bytes: pluginStart.heapUsed },
    },
    final: {
      backend: finalBackend,
      plugin: { rss_bytes: pluginEnd.rss, heap_used_bytes: pluginEnd.heapUsed },
    },
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

await main();
