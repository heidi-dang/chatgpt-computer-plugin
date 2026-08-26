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
      "cptr_code_create_directory",
      "cptr_code_move_file",
      "cptr_code_delete_file",
      "cptr_code_get_git_status",
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
      "cptr_get_task_review",
      "cptr_decide_task_review",
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
  assert.equal(tools.get("cptr_code_create_directory")?.annotations?.readOnlyHint, false);
  assert.equal(tools.get("cptr_code_move_file")?.annotations?.destructiveHint, true);
  assert.equal(tools.get("cptr_code_delete_file")?.annotations?.destructiveHint, true);
  assert.equal(tools.get("cptr_code_get_git_status")?.annotations?.readOnlyHint, true);
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
  assert.equal(tools.get("cptr_decide_task_review")?.annotations?.destructiveHint, true);
  const openMeta = tools.get("cptr_open_live_workbench")?._meta as { ui?: { resourceUri?: string } } | undefined;
  const listMeta = tools.get("cptr_list_workspaces")?._meta as { ui?: { resourceUri?: string } } | undefined;
  const startMeta = tools.get("cptr_start_task")?._meta as { ui?: { resourceUri?: string } } | undefined;
  const monitorMeta = tools.get("cptr_monitor_autonomous")?._meta as { ui?: { resourceUri?: string } } | undefined;
  const terminalMeta = tools.get("cptr_render_live_terminal")?._meta as { ui?: { resourceUri?: string } } | undefined;
  assert.equal(openMeta?.ui?.resourceUri, "ui://cptr/live-workbench.html");
  assert.equal(listMeta?.ui?.resourceUri, "ui://cptr/live-workbench.html");
  assert.equal(startMeta?.ui?.resourceUri, "ui://cptr/live-workbench.html");
  assert.equal(monitorMeta?.ui?.resourceUri, "ui://cptr/live-workbench.html");
  assert.equal(terminalMeta?.ui?.resourceUri, "ui://cptr/live-workbench.html");
  assert.equal(tools.get("cptr_monitor_autonomous")?.inputSchema.properties?.action, undefined);
  assert.equal(tools.size, 32);
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
        : url.includes("/coding/directories")
          ? { workspace_id: "ws-1", path: "src/generated", type: "directory" }
          : url.includes("/coding/move")
            ? { workspace_id: "ws-1", source: "src/app.ts", destination: "src/main.ts" }
            : url.includes("/coding/delete")
              ? { workspace_id: "ws-1", path: "src/obsolete.ts", deleted: true }
              : url.includes("/git/status")
                ? { is_repo: true, files: [{ path: "src/app.ts", status: "modified" }] }
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
    { name: "cptr_code_create_directory", arguments: { workspace_id: "ws-1", path: "src/generated" } },
    { name: "cptr_code_move_file", arguments: { workspace_id: "ws-1", source: "src/app.ts", destination: "src/main.ts" } },
    { name: "cptr_code_delete_file", arguments: { workspace_id: "ws-1", path: "src/obsolete.ts" } },
    { name: "cptr_code_get_git_status", arguments: { workspace_id: "ws-1" } },
    { name: "cptr_code_run_command", arguments: { workspace_id: "ws-1", command: "npm test" } },
    { name: "cptr_code_get_command", arguments: { workspace_id: "ws-1", command_id: "command-1" } },
    { name: "cptr_code_cancel_command", arguments: { workspace_id: "ws-1", command_id: "command-1" } },
  ];

  for (const tool of calls) {
    const result = await client.callTool(tool);
    assert.equal(result.isError, undefined, `${tool.name} should complete without an MCP error`);
    assert.ok(result.structuredContent, `${tool.name} should return structured content`);
  }

  assert.equal(seen.length, 12);
  for (const request of seen) {
    const body = request.init?.body ? JSON.parse(String(request.init.body)) : {};
    assert.equal(body.model_id, undefined);
    assert.equal((request.init?.headers as Record<string, string>).Authorization, "Bearer test-token");
  }
  assert.equal(seen[10].url.includes("offset=0&wait_seconds=0"), true);
  assert.equal(seen[11].url.endsWith("/coding/commands/command-1/cancel"), true);

  await client.close();
  await server.close();
});

test("opens the workbench immediately and binds it to a task with hidden target-bound stream metadata", async () => {
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "server-only-token",
    fetchImpl: async () => new Response(JSON.stringify({ id: "task-1", status: "RUNNING", workspace_id: "ws-1" }), { status: 200 }),
  });
  const server = createMcpServer(computer, { widgetBundle: "console.log('bundle')" });
  const client = new Client({ name: "mcp-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const initialResponse = await client.callTool({ name: "cptr_open_live_workbench", arguments: {} });
  const initialMeta = initialResponse._meta as {
    ui?: { resourceUri?: string };
    "cptr/live"?: unknown;
    "cptr/activity"?: { type?: string };
  } | undefined;
  assert.equal(initialMeta?.ui?.resourceUri, "ui://cptr/live-workbench.html");
  assert.equal(initialMeta?.["cptr/live"], undefined);
  assert.equal(initialMeta?.["cptr/activity"]?.type, "mcp.tool");

  const taskResponse = await client.callTool({
    name: "cptr_start_task",
    arguments: { workspace_id: "ws-1", prompt: "Run the bounded fixture test", model_id: "model-1" },
  });
  const taskMeta = taskResponse._meta as {
    ui?: { resourceUri?: string };
    "cptr/live"?: { ticket?: string; streamUrl?: string; snapshotUrl?: string; workspaceId?: string };
    "cptr/activity"?: { type?: string };
  } | undefined;
  assert.equal(taskMeta?.ui?.resourceUri, "ui://cptr/live-workbench.html");
  assert.ok(taskMeta?.["cptr/live"]?.ticket);
  assert.equal(taskMeta?.["cptr/live"]?.workspaceId, "ws-1");
  assert.equal(taskMeta?.["cptr/activity"]?.type, "mcp.tool");

  const response = await client.callTool({
    name: "cptr_render_live_terminal",
    arguments: { target_type: "task", target_id: "task-1" },
  });
  const text = JSON.stringify(response.content);
  assert.match(text, /task-1/);
  assert.equal(text.includes("server-only-token"), false);
  const meta = response._meta as {
    ui?: { resourceUri?: string };
    "cptr/live"?: { ticket?: string; streamUrl?: string; snapshotUrl?: string; workspaceId?: string };
  } | undefined;
  assert.ok(meta?.ui?.resourceUri);
  assert.ok(meta?.["cptr/live"]?.ticket);
  assert.ok(meta?.["cptr/live"]?.snapshotUrl);
  assert.equal(meta?.["cptr/live"]?.workspaceId, "ws-1");
  assert.equal(String(meta?.["cptr/live"]?.streamUrl).includes(meta?.["cptr/live"]?.ticket ?? ""), false);
  assert.equal(String(meta?.["cptr/live"]?.snapshotUrl).includes(meta?.["cptr/live"]?.ticket ?? ""), false);

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


test("forwards an explicit task review decision to the scoped control endpoint", async () => {
  let requestUrl = "";
  let requestBody: Record<string, unknown> | undefined;
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "server-only-token",
    fetchImpl: async (url, init) => {
      requestUrl = String(url);
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        id: "task-review",
        status: "COMPLETE",
        review: { status: "ACCEPTED", decision: { decision: "ACCEPT" } },
      }), { status: 200 });
    },
  });
  const server = createMcpServer(computer);
  const client = new Client({ name: "mcp-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const response = await client.callTool({
    name: "cptr_decide_task_review",
    arguments: { task_id: "task-review", decision: "ACCEPT", note: "Reviewed the diff." },
  });

  assert.equal(response.isError, undefined);
  assert.equal(requestUrl.endsWith("/tasks/task-review/review"), true);
  assert.deepEqual(requestBody, { decision: "ACCEPT", note: "Reviewed the diff." });

  await client.close();
  await server.close();
});


test("retrieves a task-bound review checkpoint and diff", async () => {
  let requestUrl = "";
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "server-only-token",
    fetchImpl: async (url) => {
      requestUrl = String(url);
      return new Response(JSON.stringify({
        task_id: "task-review",
        workspace_id: "ws-1",
        status: "REVIEW_REQUIRED",
        review: { status: "REQUIRED", summary: { file_count: 1 } },
        diff: { files: [{ path: "src/app.ts", hunks: [] }] },
        review_available: true,
      }), { status: 200 });
    },
  });
  const server = createMcpServer(computer);
  const client = new Client({ name: "mcp-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const response = await client.callTool({
    name: "cptr_get_task_review",
    arguments: { task_id: "task-review" },
  });

  assert.equal(response.isError, undefined);
  assert.equal(requestUrl.endsWith("/tasks/task-review/review"), true);
  assert.deepEqual(response.structuredContent, {
    task_id: "task-review",
    workspace_id: "ws-1",
    status: "REVIEW_REQUIRED",
    review: { status: "REQUIRED", summary: { file_count: 1 } },
    diff: { files: [{ path: "src/app.ts", hunks: [] }] },
    review_available: true,
  });

  await client.close();
  await server.close();
});
