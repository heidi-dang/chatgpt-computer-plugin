import assert from "node:assert/strict";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { ComputerClient } from "../server/client/computer-client.js";
import { createMcpServer } from "../server/mcp.js";


test("exposes one compact read-only persistent memory action and forwards owner-scoped reads", async () => {
  const seen: Array<{ url: string; method: string; body: unknown }> = [];
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async (input, init) => {
      const url = String(input);
      const method = String(init?.method ?? "GET");
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      seen.push({ url, method, body });
      if (url.endsWith("/memory/read")) {
        return new Response(JSON.stringify({
          action: "search",
          workspace_id: "ws-1",
          result: {
            results: [{
              memory_id: "mem-1",
              scope: "workspace",
              kind: "procedure",
              text: "Run verification before restart.",
              score: 0.95,
              reason: "hybrid retrieval",
              confidence: 0.98,
              trust_level: "verified_system_fact",
              verification_stale: false,
            }],
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    },
  });
  const server = createMcpServer(computer);
  const client = new Client({ name: "memory-bridge-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const instructions = client.getInstructions() ?? "";
  assert.match(instructions, /use cptr_memory with action=search before guessing/i);
  assert.match(instructions, /verify mutable operational facts with current evidence/i);

  const listed = await client.listTools();
  const memoryTool = listed.tools.find((tool) => tool.name === "cptr_memory");
  assert.ok(memoryTool, "cptr_memory must be registered");
  assert.equal(memoryTool.annotations?.readOnlyHint, true);
  assert.equal(memoryTool.annotations?.destructiveHint, false);
  assert.equal(memoryTool.annotations?.openWorldHint, false);
  assert.match(memoryTool.description ?? "", /persistent backend knowledge/i);
  assert.deepEqual(
    (memoryTool.inputSchema.properties?.action as { enum?: string[] } | undefined)?.enum,
    ["search", "inspect", "timeline", "health"],
  );

  const response = await client.callTool({
    name: "cptr_memory",
    arguments: {
      action: "search",
      workspace_id: "ws-1",
      query: "deployment procedure",
      limit: 8,
      include_historical: false,
      client_model: "GPT-5.6 Sol",
    },
  });
  assert.equal(response.isError, undefined);
  assert.deepEqual(seen, [{
    url: "http://cptr.test/api/control/v1/memory/read",
    method: "POST",
    body: {
      action: "search",
      workspace_id: "ws-1",
      query: "deployment procedure",
      limit: 8,
      include_historical: false,
    },
  }]);

  await client.close();
  await server.close();
});
