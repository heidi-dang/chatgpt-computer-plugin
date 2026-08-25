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
      "cptr_code_list_files",
      "cptr_code_read_file",
      "cptr_code_search_files",
      "cptr_code_write_file",
      "cptr_code_edit_file",
      "cptr_code_run_command",
      "cptr_code_get_command",
      "cptr_code_cancel_command",
      "cptr_list_workspaces",
      "cptr_get_workspace",
      "cptr_start_task",
      "cptr_execute_task",
      "cptr_monitor_autonomous",
      "cptr_get_autonomous",
      "cptr_get_autonomous_events",
      "cptr_get_autonomous_evidence",
      "cptr_steer_autonomous",
      "cptr_cancel_autonomous",
      "cptr_approve_autonomous",
      "cptr_get_task",
      "cptr_get_task_output",
      "cptr_send_message",
      "cptr_cancel_task",
      "cptr_get_diff",
    ].every((name) => tools.has(name)),
    true,
  );
  assert.equal(tools.get("cptr_code_list_files")?.annotations?.readOnlyHint, true);
  assert.equal(tools.get("cptr_code_read_file")?.annotations?.readOnlyHint, true);
  assert.equal(tools.get("cptr_code_search_files")?.annotations?.readOnlyHint, true);
  assert.equal(tools.get("cptr_code_write_file")?.annotations?.destructiveHint, true);
  assert.equal(tools.get("cptr_code_edit_file")?.annotations?.destructiveHint, true);
  assert.equal(tools.get("cptr_code_run_command")?.annotations?.openWorldHint, true);
  assert.equal(tools.get("cptr_code_run_command")?.inputSchema.properties?.model_id, undefined);
  assert.equal(tools.get("cptr_execute_task")?.annotations?.readOnlyHint, false);
  assert.equal(tools.get("cptr_execute_task")?.annotations?.destructiveHint, false);
  assert.equal(tools.get("cptr_execute_task")?.annotations?.openWorldHint, true);
  const directInputSchema = tools.get("cptr_execute_task")?.inputSchema as
    | { properties?: Record<string, { maximum?: number }> }
    | undefined;
  assert.equal(directInputSchema?.properties?.wait_seconds?.maximum, 60);
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
  assert.equal(tools.size, 24);
  for (const tool of tools.values()) {
    assert.deepEqual(tool._meta?.securitySchemes, [{ type: "oauth2", scopes: [] }]);
  }

  await client.close();
  await server.close();
});

test("invokes every direct-coding tool through MCP without a CPTR model input", async () => {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async (input, init) => {
      const url = String(input);
      seen.push({ url, init });
      const payload = url.includes("/coding/list")
        ? { workspace_id: "ws-1", path: ".", entries: "src/app.ts" }
        : url.includes("/coding/read")
          ? {
              workspace_id: "ws-1",
              path: "src/app.ts",
              content: "export {};\n",
              start_line: 1,
              end_line: 1,
              total_lines: 1,
              size: 11,
            }
          : url.includes("/coding/search")
            ? { workspace_id: "ws-1", path: "src", matches: "src/app.ts:1:export {}" }
            : url.includes("/coding/write")
              ? { workspace_id: "ws-1", path: "src/app.ts", bytes_written: 11 }
              : url.includes("/coding/edit")
                ? {
                    workspace_id: "ws-1",
                    path: "src/app.ts",
                    replaced_characters: 2,
                    inserted_characters: 12,
                  }
                : {
                    command_id: "command-1",
                    status: "COMPLETE",
                    exit_code: 0,
                    output: "ok",
                    next_offset: 2,
                  };
      return new Response(JSON.stringify(payload), { status: 200 });
    },
  });
  const server = createMcpServer(computer);
  const client = new Client({ name: "mcp-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [
    { name: "cptr_code_list_files", arguments: { workspace_id: "ws-1" } },
    { name: "cptr_code_read_file", arguments: { workspace_id: "ws-1", path: "src/app.ts" } },
    { name: "cptr_code_search_files", arguments: { workspace_id: "ws-1", query: "export" } },
    {
      name: "cptr_code_write_file",
      arguments: { workspace_id: "ws-1", path: "src/app.ts", content: "export {};\n" },
    },
    {
      name: "cptr_code_edit_file",
      arguments: { workspace_id: "ws-1", path: "src/app.ts", target: "{}", replacement: "{ value: 1 }" },
    },
    { name: "cptr_code_run_command", arguments: { workspace_id: "ws-1", command: "npm test" } },
    { name: "cptr_code_get_command", arguments: { workspace_id: "ws-1", command_id: "command-1" } },
    { name: "cptr_code_cancel_command", arguments: { workspace_id: "ws-1", command_id: "command-1" } },
  ];

  for (const tool of calls) {
    const result = await client.callTool(tool);
    assert.equal(result.isError, undefined, `${tool.name} should complete without an MCP error`);
    assert.ok(result.structuredContent, `${tool.name} should return structured content`);
  }

  assert.equal(seen.length, 8);
  for (const request of seen) {
    const body = request.init?.body ? JSON.parse(String(request.init.body)) : {};
    assert.equal(body.model_id, undefined);
    assert.equal((request.init?.headers as Record<string, string>).Authorization, "Bearer test-token");
  }
  assert.equal(seen[6].url.includes("offset=0&wait_seconds=0"), true);
  assert.equal(seen[7].url.endsWith("/coding/commands/command-1/cancel"), true);

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
