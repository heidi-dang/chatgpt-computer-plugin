import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ComputerClient } from "../server/client/computer-client.js";
import { createMcpServer } from "../server/mcp.js";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("benchmark tools are direct, bounded, and forward the current ChatGPT model", async () => {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async (url, init) => {
      const method = String(init?.method ?? "GET");
      const rawBody = typeof init?.body === "string" ? init.body : "";
      requests.push({ url: String(url), method, body: rawBody ? JSON.parse(rawBody) : null });
      if (String(url).endsWith("/api/control/v1/benchmarks/runs")) {
        return jsonResponse({
          run_id: "bench_1234567890abcdef",
          suite_id: "cptr-python-core",
          suite_version: "1",
          status: "READY",
          model_reported: "GPT-5.6 Sol",
          model_canonical: "gpt-5.6-sol",
          workspace_id: "workspace-benchmark",
          score: null,
          max_score: 100,
          case_results: [],
          error_summary: null,
          started_at_ms: 1,
          completed_at_ms: null,
          duration_ms: null,
          comparable: true,
          comparability: "standardized_suite_only",
          tasks: [],
        });
      }
      if (String(url).includes("/api/control/v1/benchmarks/leaderboard")) {
        return jsonResponse({
          comparable: true,
          comparability: "standardized_suite_only",
          suite_id: "cptr-python-core",
          suite_version: "1",
          max_score: 100,
          models: [],
        });
      }
      return jsonResponse({});
    },
  });
  const server = createMcpServer(computer);
  const client = new Client({ name: "benchmark-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const listed = await client.listTools();
  const tools = new Map(listed.tools.map((tool) => [tool.name, tool]));
  for (const name of [
    "cptr_benchmark_start",
    "cptr_benchmark_submit",
    "cptr_benchmark_get",
    "cptr_benchmark_leaderboard",
  ]) {
    const tool = tools.get(name);
    assert.ok(tool, `${name} must be registered`);
    assert.match(tool.title ?? "", /^\[ChatGPT Direct Coding\]/);
    assert.notEqual(tool.inputSchema.properties?.client_model, undefined);
  }
  assert.equal(tools.get("cptr_benchmark_start")?.annotations?.readOnlyHint, false);
  assert.equal(tools.get("cptr_benchmark_submit")?.annotations?.readOnlyHint, false);
  assert.equal(tools.get("cptr_benchmark_get")?.annotations?.readOnlyHint, true);
  assert.equal(tools.get("cptr_benchmark_leaderboard")?.annotations?.readOnlyHint, true);

  const started = await client.callTool({
    name: "cptr_benchmark_start",
    arguments: { suite_id: "cptr-python-core", client_model: "GPT-5.6 Sol" },
  });
  assert.equal(started.isError, undefined);
  const startRequest = requests.find((item) => item.url.endsWith("/api/control/v1/benchmarks/runs"));
  assert.ok(startRequest);
  assert.equal(startRequest.method, "POST");
  assert.deepEqual(startRequest.body, {
    suite_id: "cptr-python-core",
    model_reported: "GPT-5.6 Sol",
  });

  const leaderboard = await client.callTool({
    name: "cptr_benchmark_leaderboard",
    arguments: { suite_id: "cptr-python-core", client_model: "GPT-5.6 Sol" },
  });
  assert.equal(leaderboard.isError, undefined);

  await client.close();
  await server.close();
});
