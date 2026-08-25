import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ComputerClient } from "../server/client/computer-client.js";
import { createMcpServer } from "../server/mcp.js";

test("advertises dedicated autonomous tools with accurate annotations", async () => {
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async () => new Response(JSON.stringify({}), { status: 200 }),
  });
  const server = createMcpServer(computer);
  const client = new Client({ name: "mcp-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const listed = await client.listTools();
  const tools = new Map(listed.tools.map((tool) => [tool.name, tool]));

  assert.deepEqual(
    [
      "cptr_monitor_autonomous",
      "cptr_get_autonomous",
      "cptr_get_autonomous_events",
      "cptr_get_autonomous_evidence",
      "cptr_steer_autonomous",
      "cptr_cancel_autonomous",
      "cptr_approve_autonomous",
    ].every((name) => tools.has(name)),
    true,
  );
  assert.equal(tools.get("cptr_monitor_autonomous")?.annotations?.readOnlyHint, false);
  assert.equal(tools.get("cptr_monitor_autonomous")?.annotations?.destructiveHint, false);
  assert.equal(tools.get("cptr_get_autonomous")?.annotations?.readOnlyHint, true);
  assert.equal(tools.get("cptr_get_autonomous_events")?.annotations?.readOnlyHint, true);
  assert.equal(tools.get("cptr_get_autonomous_evidence")?.annotations?.readOnlyHint, true);
  assert.equal(tools.get("cptr_cancel_autonomous")?.annotations?.destructiveHint, true);
  assert.equal(tools.get("cptr_approve_autonomous")?.annotations?.destructiveHint, true);
  assert.equal(tools.get("cptr_approve_autonomous")?.annotations?.openWorldHint, true);
  const startMeta = tools.get("cptr_start_task")?._meta as { ui?: { resourceUri?: string } } | undefined;
  const monitorMeta = tools.get("cptr_monitor_autonomous")?._meta as { ui?: { resourceUri?: string } } | undefined;
  assert.equal(startMeta?.ui?.resourceUri, "ui://cptr/live-workbench.html");
  assert.equal(monitorMeta?.ui?.resourceUri, "ui://cptr/live-workbench.html");
  assert.equal(tools.get("cptr_monitor_autonomous")?.inputSchema.properties?.action, undefined);
  assert.equal(tools.size, 15);
  for (const tool of tools.values()) {
    assert.deepEqual(tool._meta?.securitySchemes, [{ type: "oauth2", scopes: [] }]);
  }

  await client.close();
  await server.close();
});

test("hydrates task creation with hidden workbench metadata without changing tool output", async () => {
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "server-only-token",
    fetchImpl: async () => new Response(JSON.stringify({ id: "task-1", status: "RUNNING", workspace_id: "ws-1" }), { status: 200 }),
  });
  const server = createMcpServer(computer, { widgetBundle: "console.log('bundle')" });
  const client = new Client({ name: "mcp-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const response = await client.callTool({
    name: "cptr_start_task",
    arguments: { workspace_id: "ws-1", prompt: "Run the bounded fixture test", model_id: "model-1" },
  });
  const text = JSON.stringify(response.content);
  assert.match(text, /task-1/);
  assert.equal(text.includes("server-only-token"), false);
  const meta = response._meta as {
    ui?: { resourceUri?: string };
    "cptr/live"?: { ticket?: string; streamUrl?: string };
  } | undefined;
  assert.ok(meta?.ui?.resourceUri);
  assert.ok(meta?.["cptr/live"]?.ticket);
  assert.equal(String(meta?.["cptr/live"]?.streamUrl).includes(meta?.["cptr/live"]?.ticket ?? ""), false);

  await client.close();
  await server.close();
});

test("adds assignment scope to direct MCP tasks before they reach CPTR", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "server-only-token",
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ id: "task-scoped", status: "RUNNING", workspace_id: "ws-1" }), { status: 200 });
    },
  });
  const server = createMcpServer(computer);
  const client = new Client({ name: "mcp-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  await client.callTool({
    name: "cptr_start_task",
    arguments: {
      workspace_id: "ws-1",
      prompt: "Create CHATGPT_LIVE_WORKBENCH_OK.txt with the requested marker, then wait for steering.",
      model_id: "heidi-antigravity",
    },
  });

  assert.match(String(requestBody?.prompt), /inspection_scope=assignment/);
  assert.match(String(requestBody?.prompt), /Only inspect or mutate files explicitly named/);
  assert.match(String(requestBody?.prompt), /CHATGPT_LIVE_WORKBENCH_OK\.txt/);

  await client.close();
  await server.close();
});
