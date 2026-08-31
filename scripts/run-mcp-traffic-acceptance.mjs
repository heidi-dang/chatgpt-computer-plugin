import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const cptrSource = process.env.CPTR_SOURCE_DIR?.trim();
if (!cptrSource) throw new Error("CPTR_SOURCE_DIR is required");

const host = "127.0.0.1";
const timeoutMs = Math.max(5_000, Math.min(60_000, Number(process.env.MCP_TRAFFIC_ACCEPTANCE_TIMEOUT_MS ?? "20000") || 20_000));
const python = process.env.PYTHON ?? "python";
const nodeExecutable = process.execPath;
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cptr-mcp-traffic-acceptance-"));
const children = [];

function randomToken(prefix) {
  return `${prefix}-${randomUUID()}`;
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function spawnLogged(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? process.cwd(),
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  const capture = (prefix) => (chunk) => {
    const text = String(chunk);
    output.push(`${prefix}${text}`);
    if (output.join("").length > 40_000) output.splice(0, Math.max(1, output.length - 20));
  };
  child.stdout.on("data", capture("stdout: "));
  child.stderr.on("data", capture("stderr: "));
  children.push({ child, output });
  return { child, output };
}

async function waitForHttp(url, headers = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not started";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers });
      if (response.ok) return response;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError}`);
}

async function stopChildren() {
  await Promise.all(children.map(async ({ child }) => {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }));
}

const [cptrPort, pluginPort, failurePluginPort] = await Promise.all([
  reservePort(),
  reservePort(),
  reservePort(),
]);
assert.ok(cptrPort && pluginPort && failurePluginPort);

const controlToken = randomToken("control");
const failureControlToken = randomToken("control-failure");
const mcpToken = randomToken("mcp");
const failureMcpToken = randomToken("mcp-failure");
const adminCookie = `acceptance=${randomUUID()}`;

try {
  const harness = spawnLogged(
    python,
    [
      "scripts/mcp-traffic-cptr-harness.py",
      "--host", host,
      "--port", String(cptrPort),
      "--cptr-source", cptrSource,
      "--control-token", controlToken,
      "--failure-control-token", failureControlToken,
    ],
  );
  await waitForHttp(`http://${host}:${cptrPort}/health`);

  const commonPluginEnv = {
    HOST: host,
    CPTR_BASE_URL: `http://${host}:${cptrPort}`,
    NODE_ENV: "development",
    CPTR_NOTIFY_TOOL_LIST_CHANGED: "0",
  };
  const successPlugin = spawnLogged(
    nodeExecutable,
    ["--import", "tsx", "server/index.ts"],
    {
      env: {
        ...commonPluginEnv,
        PORT: String(pluginPort),
        PUBLIC_ORIGIN: `http://${host}:${pluginPort}`,
        MCP_ACCESS_TOKEN: mcpToken,
        CPTR_API_TOKEN: controlToken,
      },
    },
  );
  const failurePlugin = spawnLogged(
    nodeExecutable,
    ["--import", "tsx", "server/index.ts"],
    {
      env: {
        ...commonPluginEnv,
        PORT: String(failurePluginPort),
        PUBLIC_ORIGIN: `http://${host}:${failurePluginPort}`,
        MCP_ACCESS_TOKEN: failureMcpToken,
        CPTR_API_TOKEN: failureControlToken,
      },
    },
  );

  await Promise.all([
    waitForHttp(`http://${host}:${pluginPort}/health`),
    waitForHttp(`http://${host}:${failurePluginPort}/health`),
  ]);

  const verifier = spawnLogged(
    nodeExecutable,
    ["scripts/check-mcp-traffic-integration.mjs"],
    {
      env: {
        MCP_URL: `http://${host}:${pluginPort}/mcp`,
        MCP_ACCESS_TOKEN: mcpToken,
        CPTR_BASE_URL: `http://${host}:${cptrPort}`,
        CPTR_ADMIN_COOKIE: adminCookie,
        MCP_FAILURE_URL: `http://${host}:${failurePluginPort}/mcp`,
        MCP_FAILURE_ACCESS_TOKEN: failureMcpToken,
        MCP_TRAFFIC_ACCEPTANCE_TIMEOUT_MS: String(timeoutMs),
      },
    },
  );
  const verifierExit = await new Promise((resolve) => verifier.child.once("exit", (code) => resolve(code ?? 1)));
  if (verifierExit !== 0) {
    throw new Error(`Two-client verifier failed:\n${verifier.output.join("").slice(-20_000)}`);
  }
  const verifierText = verifier.output.join("");
  const jsonStart = verifierText.lastIndexOf("{\n");
  const summary = jsonStart >= 0 ? JSON.parse(verifierText.slice(jsonStart).replace(/^stdout:\s?/gm, "")) : null;
  assert.equal(summary?.ok, true);
  assert.equal(summary?.failure_isolation, "passed");

  console.log(JSON.stringify({
    ok: true,
    harness: "actual CPTR McpTrafficStore + schema",
    clients: summary.clients,
    request_tool_ordering: summary.request_tool_ordering,
    telemetry_secret_absence: summary.telemetry_secret_absence,
    session_close: summary.session_close,
    failure_isolation: summary.failure_isolation,
    observed_traffic_events: summary.observed_traffic_events,
    ports: { cptr: cptrPort, plugin: pluginPort, failure_plugin: failurePluginPort },
  }, null, 2));

  void harness;
  void successPlugin;
  void failurePlugin;
} finally {
  await stopChildren();
  await rm(tempRoot, { recursive: true, force: true });
}
