import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ComputerClient } from "../server/client/computer-client.js";
import { createMcpServer } from "../server/mcp.js";

test("prepares direct-coding context and manages explicit workspace memory without delegation", async () => {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async (input, init) => {
      const url = String(input);
      seen.push({ url, init });
      let payload: Record<string, unknown> = { workspace_id: "ws-1" };
      if (url.includes("/workspace-memory/workspaces/ws-1/context")) {
        payload = {
          workspace_id: "ws-1",
          memory_cursor: 7,
          workspace_stage: { last_completed: "Updated direct tools" },
          relevant_facts: [{ fact_id: "wmf_1234567890abcdef", status: "ACTIVE", content: "Use direct tools" }],
          freshness: { has_memory: true, matches_current_workspace_fingerprint: true },
        };
      } else if (url.includes("/workspace-memory/workspaces/ws-1/timeline")) {
        payload = { workspace_id: "ws-1", events: [], last_sequence: 7 };
      } else if (url.includes("/coding/read")) {
        payload = {
          workspace_id: "ws-1",
          path: "server/mcp.ts",
          content: "export const memory = true;",
          start_line: 1,
          end_line: 1,
          total_lines: 1,
          size: 27,
        };
      } else if (url.endsWith("/workspace-memory/facts")) {
        payload = {
          fact_id: "wmf_1234567890abcdef",
          category: "decision",
          content: "Use direct CPTR tools.",
          paths: ["server/mcp.ts"],
          source_event_id: null,
          status: "ACTIVE",
          pinned: true,
          revision: 1,
          verified_fingerprint: null,
          created_at: 1,
          updated_at: 1,
        };
      } else if (url.includes("/workspace-memory/events")) {
        payload = { event: { event_id: "wme_123", sequence: 8 }, idempotent: false };
      }
      return new Response(JSON.stringify(payload), { status: 200 });
    },
  });
  const server = createMcpServer(computer);
  const client = new Client({ name: "memory-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const context = await client.callTool({
    name: "cptr_prepare_workspace_context",
    arguments: { workspace_id: "ws-1" },
  });
  assert.equal(context.isError, undefined);
  assert.equal((context.structuredContent as { memory_cursor: number }).memory_cursor, 7);
  const contextCall = seen.find(({ url }) => url.includes("/workspace-memory/workspaces/ws-1/context"));
  assert.ok(contextCall);
  assert.equal(contextCall?.url.includes("refresh=true"), false, "fast context mode must be the default");

  const record = await client.callTool({
    name: "cptr_workspace_memory_record_fact",
    arguments: {
      workspace_id: "ws-1",
      category: "decision",
      content: "Use direct CPTR tools.",
      pinned: true,
      paths: ["server/mcp.ts"],
    },
  });
  assert.equal(record.isError, undefined);
  const factRequest = seen.find(({ url }) => url.endsWith("/workspace-memory/facts"));
  assert.deepEqual(JSON.parse(String(factRequest?.init?.body)), {
    workspace_id: "ws-1",
    category: "decision",
    content: "Use direct CPTR tools.",
    pinned: true,
    paths: ["server/mcp.ts"],
  });

  const read = await client.callTool({
    name: "cptr_code_read_file",
    arguments: { workspace_id: "ws-1", path: "server/mcp.ts" },
  });
  assert.equal(read.isError, undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const automatic = seen.find(({ url }) => url.endsWith("/workspace-memory/events"));
  assert.ok(automatic, "direct CPTR tools should automatically append a memory event");
  const automaticBody = JSON.parse(String(automatic?.init?.body)) as Record<string, unknown>;
  assert.equal(automaticBody.workspace_id, "ws-1");
  assert.equal(automaticBody.kind, "workspace.inspected");
  assert.equal(automaticBody.tool_name, "cptr_code_read_file");
  assert.equal("prompt" in automaticBody, false);
  assert.equal("output" in automaticBody, false);

  await client.close();
  await server.close();
});

test("requires literal confirmation before registering the destructive memory clear tool", async () => {
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async () => new Response(JSON.stringify({ workspace_id: "ws-1", cleared_at: 1, cursor: 0 }), { status: 200 }),
  });
  const server = createMcpServer(computer);
  const client = new Client({ name: "memory-clear-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const unconfirmed = await client.callTool({
    name: "cptr_workspace_memory_clear",
    arguments: { workspace_id: "ws-1" },
  });
  assert.equal(unconfirmed.isError, true);

  const confirmed = await client.callTool({
    name: "cptr_workspace_memory_clear",
    arguments: { workspace_id: "ws-1", confirm: true },
  });
  assert.equal(confirmed.isError, undefined);

  await client.close();
  await server.close();
});
