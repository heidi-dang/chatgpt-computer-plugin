import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ComputerClient } from "../server/client/computer-client.js";
import { MCP_CONTRACT_TOOL_COUNT, MCP_CONTRACT_VERSION, createMcpServer } from "../server/mcp.js";
import { PromptTerminalStore } from "../server/prompt-terminal.js";
import { CPTR_APP_VERSION } from "../server/version.js";

async function authorizeDelegation(client: Client) {
  return client.callTool({
    name: "cptr_open_live_workbench",
    arguments: { delegation_authorization: "allow:delegate" },
  });
}

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
  assert.equal(client.getServerVersion()?.version, CPTR_APP_VERSION);
  const listed = await client.listTools();
  const tools = new Map(listed.tools.map((tool) => [tool.name, tool]));

  assert.deepEqual(
    [
      "cptr_open_live_workbench",
      "cptr_list_workbench_sessions",
      "cptr_get_workbench_session",
      "cptr_get_workbench_session_events",
      "cptr_bind_live_workbench_session",
      "cptr_rename_workbench_session",
      "cptr_archive_workbench_session",
      "cptr_request_delete_workbench_session",
      "cptr_confirm_delete_workbench_session",
      "cptr_workspace_detect_project",
      "cptr_workspace_tree",
      "cptr_workspace_file_metadata",
      "cptr_workspace_read_many",
      "cptr_workspace_search_symbols",
      "cptr_workspace_discover_tests",
      "cptr_workspace_dependency_summary",
      "cptr_workspace_package_scripts",
      "cptr_workspace_release_readiness",
      "cptr_workspace_run_test_target",
      "cptr_list_models",
      "cptr_list_tasks",
      "cptr_list_autonomous",
      "cptr_get_task_events",
      "cptr_code_read_many_files",
      "cptr_code_apply_edits",
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
      "cptr_code_send_input",
      "cptr_code_resize_command",
      "cptr_code_signal_command",
      "cptr_lsp_discover",
      "cptr_lsp_start",
      "cptr_lsp_request",
      "cptr_lsp_stop",
      "cptr_direct_worker_create",
      "cptr_direct_worker_list",
      "cptr_direct_worker_get",
      "cptr_direct_workers_overview",
      "cptr_direct_workers_integrate",
      "cptr_direct_worker_close",
      "cptr_fdx_intelligence",
      "cptr_ssh_list_hosts",
      "cptr_ssh_run_command",
      "cptr_ssh_get_command",
      "cptr_ssh_cancel_command",
      "cptr_chrome_browser",
      "cptr_plugin_update",
      "cptr_benchmark_start",
      "cptr_benchmark_submit",
      "cptr_benchmark_get",
      "cptr_benchmark_leaderboard",
      "cptr_list_workspaces",
      "cptr_get_workspace",
      "cptr_start_task",
      "cptr_execute_task",
      "cptr_monitor_autonomous",
      "cptr_render_live_terminal",
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
    ].sort(),
    [...tools.keys()].sort(),
  );
  assert.equal(tools.get("cptr_code_list_files")?.annotations?.readOnlyHint, true);
  assert.equal(tools.get("cptr_code_read_file")?.annotations?.readOnlyHint, true);
  assert.equal(tools.get("cptr_code_search_files")?.annotations?.readOnlyHint, true);
  assert.equal(tools.get("cptr_fdx_intelligence")?.annotations?.readOnlyHint, true);
  assert.equal(tools.get("cptr_fdx_intelligence")?.annotations?.destructiveHint, false);
  assert.equal(tools.get("cptr_fdx_intelligence")?.annotations?.openWorldHint, false);
  assert.match(tools.get("cptr_fdx_intelligence")?.title ?? "", /^\[ChatGPT Direct Coding\]/);
  assert.match(tools.get("cptr_fdx_intelligence")?.description ?? "", /preferred first repository-intelligence/i);
  assert.notEqual(tools.get("cptr_fdx_intelligence")?.inputSchema.properties?.action, undefined);
  assert.notEqual(tools.get("cptr_fdx_intelligence")?.inputSchema.properties?.worker_id, undefined);
  assert.equal(tools.get("cptr_fdx_intelligence")?.inputSchema.properties?.model_id, undefined);
  assert.equal(tools.get("cptr_code_write_file")?.annotations?.destructiveHint, true);
  assert.equal(tools.get("cptr_code_edit_file")?.annotations?.destructiveHint, true);
  assert.equal(tools.get("cptr_code_create_directory")?.annotations?.readOnlyHint, false);
  assert.equal(tools.get("cptr_code_move_file")?.annotations?.destructiveHint, true);
  assert.equal(tools.get("cptr_code_delete_file")?.annotations?.destructiveHint, true);
  assert.equal(tools.get("cptr_code_get_git_status")?.annotations?.readOnlyHint, true);
  assert.equal(tools.get("cptr_code_run_command")?.annotations?.openWorldHint, true);
  assert.equal(tools.get("cptr_code_run_command")?.inputSchema.properties?.model_id, undefined);
  assert.equal(tools.get("cptr_workspace_detect_project")?.annotations?.readOnlyHint, true);
  assert.equal(tools.get("cptr_workspace_read_many")?.annotations?.readOnlyHint, true);
  assert.equal(tools.get("cptr_workspace_run_test_target")?.annotations?.openWorldHint, false);
  assert.equal(tools.get("cptr_workspace_run_test_target")?.inputSchema.properties?.command, undefined);
  assert.notEqual(tools.get("cptr_workspace_run_test_target")?.inputSchema.properties?.target, undefined);
  assert.match(tools.get("cptr_code_run_command")?.title ?? "", /^\[ChatGPT Direct Coding\]/);
  assert.match(tools.get("cptr_code_run_command")?.description ?? "", /ChatGPT itself must inspect, edit, run, verify/);
  assert.match(tools.get("cptr_start_task")?.title ?? "", /^\[Delegated Agent\]/);
  assert.match(tools.get("cptr_start_task")?.description ?? "", /allow:delegate/);
  assert.match(tools.get("cptr_start_task")?.description ?? "", /Codex or Hermes/);
  assert.notEqual(tools.get("cptr_open_live_workbench")?.inputSchema.properties?.delegation_authorization, undefined);
  assert.equal(tools.get("cptr_ssh_list_hosts")?.annotations?.readOnlyHint, true);
  assert.equal(tools.get("cptr_ssh_run_command")?.annotations?.openWorldHint, true);
  assert.equal(tools.get("cptr_ssh_get_command")?.annotations?.readOnlyHint, true);
  assert.equal(tools.get("cptr_ssh_cancel_command")?.annotations?.destructiveHint, true);
  assert.equal(tools.get("cptr_chrome_browser")?.annotations?.readOnlyHint, false);
  assert.equal(tools.get("cptr_chrome_browser")?.annotations?.openWorldHint, true);
  assert.notEqual(tools.get("cptr_chrome_browser")?.inputSchema.properties?.action, undefined);
  assert.equal(tools.get("cptr_execute_task")?.annotations?.readOnlyHint, false);
  assert.equal(tools.get("cptr_execute_task")?.annotations?.destructiveHint, false);
  assert.equal(tools.get("cptr_execute_task")?.annotations?.openWorldHint, true);
  const directInputSchema = tools.get("cptr_execute_task")?.inputSchema as
    | { properties?: Record<string, { maximum?: number }> }
    | undefined;
  assert.equal(directInputSchema?.properties?.wait_seconds?.maximum, 60);
  assert.notEqual(tools.get("cptr_start_task")?.inputSchema.properties?.execution_policy, undefined);
  assert.notEqual(tools.get("cptr_execute_task")?.inputSchema.properties?.execution_policy, undefined);
  assert.notEqual(tools.get("cptr_monitor_autonomous")?.inputSchema.properties?.execution_policy, undefined);
  assert.notEqual(tools.get("cptr_render_live_terminal")?.inputSchema.properties?.presentation, undefined);
  assert.equal(tools.get("cptr_monitor_autonomous")?.annotations?.readOnlyHint, false);
  assert.equal(tools.get("cptr_monitor_autonomous")?.annotations?.destructiveHint, false);
  assert.equal(tools.get("cptr_get_autonomous")?.annotations?.readOnlyHint, true);
  assert.equal(tools.get("cptr_get_autonomous_events")?.annotations?.readOnlyHint, true);
  assert.equal(tools.get("cptr_get_autonomous_evidence")?.annotations?.readOnlyHint, true);
  assert.equal(tools.get("cptr_cancel_autonomous")?.annotations?.destructiveHint, true);
  assert.equal(tools.get("cptr_approve_autonomous")?.annotations?.destructiveHint, true);
  assert.equal(tools.get("cptr_approve_autonomous")?.annotations?.openWorldHint, true);
  assert.equal(tools.get("cptr_decide_task_review")?.annotations?.destructiveHint, true);
  const renderedTools = [...tools.values()]
    .filter((tool) => (tool._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri)
    .map((tool) => tool.name);
  assert.deepEqual(renderedTools, ["cptr_open_live_workbench"]);
  const terminalMeta = tools.get("cptr_open_live_workbench")?._meta as { ui?: { resourceUri?: string } } | undefined;
  assert.equal(terminalMeta?.ui?.resourceUri, "ui://cptr/live-workbench.html");
  const bindMeta = tools.get("cptr_render_live_terminal")?._meta as { ui?: { resourceUri?: string } } | undefined;
  assert.equal(bindMeta?.ui, undefined);
  assert.equal(tools.get("cptr_monitor_autonomous")?.inputSchema.properties?.action, undefined);
  assert.equal(tools.get("cptr_plugin_update")?.annotations?.readOnlyHint, true);
  assert.equal(tools.get("cptr_plugin_update")?.annotations?.openWorldHint, false);
  assert.match(CPTR_APP_VERSION, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  assert.equal(MCP_CONTRACT_VERSION, CPTR_APP_VERSION);
  assert.equal(MCP_CONTRACT_TOOL_COUNT, 74);
  assert.equal(tools.size, MCP_CONTRACT_TOOL_COUNT + 6);
  for (const tool of tools.values()) {
    assert.deepEqual(tool._meta?.securitySchemes, [{ type: "oauth2", scopes: [] }]);
  }

  await client.close();
  await server.close();
});

test("requires prompt-session allow:delegate authorization for delegated agent tools", async () => {
  let modelRequests = 0;
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async (url) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith("/models")) modelRequests += 1;
      if (requestUrl.endsWith("/workbench-sessions")) {
        return new Response(JSON.stringify({
          session_id: "wbs_session_00000001",
          name: "Delegation fixture",
          status: "OPEN",
          workspace_id: null,
          active_target_type: null,
          active_target_id: null,
          active_workspace_id: null,
          event_count: 0,
          created_at: 1,
          updated_at: 1,
          last_event_at: null,
          archived_at: null,
        }), { status: 200 });
      }
      if (requestUrl.includes("/workspaces?")) {
        return new Response(JSON.stringify({ workspaces: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    },
  });
  const server = createMcpServer(computer);
  const client = new Client({ name: "mcp-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const beforeOpen = await client.callTool({ name: "cptr_list_models", arguments: {} });
  assert.equal(beforeOpen.isError, true);
  assert.match(JSON.stringify(beforeOpen.content), /allow:delegate/);
  assert.equal(modelRequests, 0, "delegation must fail before the backend is contacted");

  const directOnly = await client.callTool({ name: "cptr_open_live_workbench", arguments: {} });
  assert.equal((directOnly.structuredContent as { delegation_allowed?: boolean } | undefined)?.delegation_allowed, false);
  const blocked = await client.callTool({ name: "cptr_list_models", arguments: {} });
  assert.equal(blocked.isError, true);
  assert.match(JSON.stringify(blocked.content), /allow:delegate/);
  assert.equal(modelRequests, 0);

  const delegated = await client.callTool({
    name: "cptr_open_live_workbench",
    arguments: { delegation_authorization: "allow:delegate" },
  });
  assert.equal((delegated.structuredContent as { delegation_allowed?: boolean } | undefined)?.delegation_allowed, true);
  const models = await client.callTool({ name: "cptr_list_models", arguments: {} });
  assert.equal(models.isError, undefined);
  assert.equal(modelRequests, 1);

  await client.close();
  await server.close();
});

test("returns typed MCP error envelopes for structured CPTR API failures", async () => {
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async () => new Response(
      JSON.stringify({
        detail: {
          code: "STALE_HASH",
          message: "file changed since it was read",
          retriable: true,
          field: "expected_sha256",
        },
      }),
      { status: 409 },
    ),
  });
  const server = createMcpServer(computer);
  const client = new Client({ name: "mcp-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const response = await client.callTool({
    name: "cptr_code_write_file",
    arguments: {
      workspace_id: "ws-1",
      path: "src/app.ts",
      content: "export {};\n",
      overwrite: true,
      expected_sha256: "a".repeat(64),
    },
  });

  assert.equal(response.isError, true);
  assert.equal(response.structuredContent, undefined);
  const content = response.content as Array<{ type: string; text?: string }>;
  const first = content[0];
  assert.equal(first?.type, "text");
  assert.deepEqual(JSON.parse(first?.type === "text" ? first.text ?? "{}" : "{}"), {
    code: "STALE_HASH",
    message: "file changed since it was read",
    retriable: true,
    field: "expected_sha256",
  });

  await client.close();
  await server.close();
});

test("reports plugin release status through the stable update action", async () => {
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async () => new Response(JSON.stringify({}), { status: 200 }),
  });
  const server = createMcpServer(computer);
  const client = new Client({ name: "mcp-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const response = await client.callTool({
    name: "cptr_plugin_update",
    arguments: {
      action: "verify_server",
      expected_contract_version: CPTR_APP_VERSION,
      expected_tool_count: 74,
    },
  });
  const value = response.structuredContent as Record<string, unknown> | undefined;
  assert.equal(response.isError, undefined);
  assert.equal(value?.version, CPTR_APP_VERSION);
  assert.equal(value?.tool_count, 74);
  assert.equal(value?.contract_matches, true);
  assert.equal(value?.tool_count_matches, true);
  assert.deepEqual((value?.verification as { tool?: string } | undefined)?.tool, "cptr_plugin_update");

  await client.close();
  await server.close();
});

test("invokes managed Chrome control through the ChatGPT-visible MCP tool", async () => {
  const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async (input, init) => {
      seen.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : {},
      });
      return new Response(
        JSON.stringify({
          workspace_id: "ws-1",
          action: "status",
          status: "ready",
          managed: true,
          available: true,
          active: false,
          browser: "google-chrome",
        }),
        { status: 200 },
      );
    },
  });
  const server = createMcpServer(computer);
  const client = new Client({ name: "mcp-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const response = await client.callTool({
    name: "cptr_chrome_browser",
    arguments: { workspace_id: "ws-1", action: "status" },
  });

  assert.equal(response.isError, undefined);
  assert.equal((response.structuredContent as { status?: string } | undefined)?.status, "ready");
  assert.deepEqual(seen, [
    {
      url: "http://cptr.test/api/control/v1/workspaces/ws-1/browser",
      body: {
        action: "status",
        modifiers: [],
        direction: "down",
        amount: 3,
        allow_network: false,
      },
    },
  ]);

  await client.close();
  await server.close();
});

test("invokes every direct-coding tool through MCP without a CPTR model input", async () => {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const sha = "a".repeat(64);
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async (input, init) => {
      const url = String(input);
      seen.push({ url, init });
      const payload = url.includes("/coding/list")
        ? {
            workspace_id: "ws-1",
            path: ".",
            entries: [{ path: "src/app.ts", type: "file", size: 11 }],
            total: 1,
            truncated: false,
            max_entries: 500,
            cursor: null,
          }
        : url.includes("/coding/directories")
          ? { workspace_id: "ws-1", path: "src/generated", type: "directory", created: true }
          : url.includes("/coding/move")
            ? { workspace_id: "ws-1", source: "src/app.ts", destination: "src/main.ts", sha256: sha }
            : url.includes("/coding/delete")
              ? { workspace_id: "ws-1", path: "src/obsolete.ts", deleted: true, existed: true }
              : url.includes("/git/status")
                ? {
                    is_repo: true,
                    branch: "main",
                    ahead: 0,
                    behind: 0,
                    files: [{ path: "src/app.ts", status: "modified", staged: false, unstaged: true }],
                  }
        : url.includes("/coding/read")
          ? {
              workspace_id: "ws-1",
              path: "src/app.ts",
              content: "export {};\n",
              start_line: 1,
              end_line: 1,
              total_lines: 1,
              size: 11,
              content_sha256: sha,
            }
          : url.includes("/coding/search")
            ? {
                workspace_id: "ws-1",
                path: "src",
                matches: [{ path: "src/app.ts", line: 1, text: "export {}" }],
                max_results: 100,
                truncated: false,
              }
            : url.includes("/coding/write")
              ? { workspace_id: "ws-1", path: "src/app.ts", bytes_written: 11, sha256: sha }
              : url.includes("/coding/edit")
                ? {
                    workspace_id: "ws-1",
                    path: "src/app.ts",
                    replaced_characters: 2,
                    inserted_characters: 12,
                    sha256: sha,
                    diff: "@@ -1 +1 @@",
                  }
                : {
                    command_id: "command-1",
                    status: "COMPLETE",
                    exit_code: 0,
                    output: "ok",
                    next_offset: 2,
                    duration_ms: 1,
                    output_truncated: false,
                    timed_out: false,
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

  const results = new Map<string, Awaited<ReturnType<typeof client.callTool>>>();
  for (const tool of calls) {
    const result = await client.callTool(tool);
    results.set(tool.name, result);
    assert.equal(result.isError, undefined, `${tool.name} should complete without an MCP error`);
    assert.ok(result.structuredContent, `${tool.name} should return structured content`);
  }

  for (const name of ["cptr_code_run_command", "cptr_code_get_command", "cptr_code_cancel_command"]) {
    const meta = results.get(name)?._meta as {
      ui?: { resourceUri?: string };
      "cptr/live"?: unknown;
    } | undefined;
    assert.equal(meta?.ui, undefined, `${name} must remain data-only and must not mount another terminal widget`);
    assert.equal(meta?.["cptr/live"], undefined, `${name} must bind through the already-open prompt terminal instead of returning another live widget`);
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

test("routes dedicated SSH tools through the SSH control API and live command target", async () => {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async (input, init) => {
      const url = String(input);
      seen.push({ url, init });
      const payload = url.endsWith("/ssh/hosts")
        ? { workspace_id: "ws-1", aliases: ["aws"] }
        : {
            workspace_id: "ws-1",
            alias: "aws",
            command_id: "ssh-command-1",
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

  const hosts = await client.callTool({
    name: "cptr_ssh_list_hosts",
    arguments: { workspace_id: "ws-1" },
  });
  assert.deepEqual(hosts.structuredContent, { workspace_id: "ws-1", aliases: ["aws"] });

  const run = await client.callTool({
    name: "cptr_ssh_run_command",
    arguments: { workspace_id: "ws-1", alias: "aws", command: "uname -a" },
  });
  await client.callTool({
    name: "cptr_ssh_get_command",
    arguments: { workspace_id: "ws-1", command_id: "ssh-command-1" },
  });
  await client.callTool({
    name: "cptr_ssh_cancel_command",
    arguments: { workspace_id: "ws-1", command_id: "ssh-command-1" },
  });

  const live = run._meta as { ui?: unknown; "cptr/live"?: unknown } | undefined;
  assert.equal(live?.ui, undefined);
  assert.equal(live?.["cptr/live"], undefined);

  assert.equal(seen.length, 4);
  assert.equal(seen[0].url.endsWith("/workspaces/ws-1/ssh/hosts"), true);
  assert.equal(seen[1].url.endsWith("/workspaces/ws-1/ssh/commands"), true);
  assert.deepEqual(JSON.parse(String(seen[1].init?.body)), {
    alias: "aws",
    command: "uname -a",
    wait_seconds: 0,
  });
  assert.equal(seen[2].url.includes("/ssh/commands/ssh-command-1?offset=0&wait_seconds=0"), true);
  assert.equal(seen[3].url.endsWith("/ssh/commands/ssh-command-1/cancel"), true);

  await client.close();
  await server.close();
});

test("mounts exactly one prompt terminal through open and keeps later target binding data-only", async () => {
  const liveEvents = Array.from({ length: 25 }, (_, index) => ({
    version: 1,
    event_id: `event-${index + 1}`,
    sequence: index + 1,
    timestamp: "2026-08-27T10:00:00Z",
    target: { type: "task", id: "task-1" },
    task_id: "task-1",
    monitor_id: null,
    worker_task_id: null,
    type: "terminal.chunk",
    payload: { text: `safe-${index + 1}` },
    redaction_applied: true,
  }));
  let workspaceRequests = 0;
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "server-only-token",
    fetchImpl: async (url) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith("/workbench-sessions")) {
        return new Response(JSON.stringify({
          session_id: "wbs_session_00000001",
          name: "CPTR plugin session",
          status: "OPEN",
          workspace_id: null,
          active_target_type: null,
          active_target_id: null,
          active_workspace_id: null,
          event_count: 0,
          created_at: 1,
          updated_at: 1,
          last_event_at: null,
          archived_at: null,
        }), { status: 200 });
      }
      if (requestUrl.includes("/workspaces?")) {
        workspaceRequests += 1;
        return new Response(JSON.stringify({
          workspaces: [{ workspace_id: "ws-1", name: "Fixture", available: true, last_used_at: 1 }],
        }), { status: 200 });
      }
      if (requestUrl.includes("/stream/snapshot?")) {
        return new Response(JSON.stringify({ events: liveEvents, last_sequence: 25 }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "task-1", status: "RUNNING", workspace_id: "ws-1" }), { status: 200 });
    },
  });
  const promptSessions = new PromptTerminalStore();
  const server = createMcpServer(computer, {
    widgetBundle: "console.log('bundle')",
    promptSessions,
  });
  const client = new Client({ name: "mcp-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const initialResponse = await authorizeDelegation(client);
  const initialMeta = initialResponse._meta as {
    ui?: { resourceUri?: string };
    "cptr/live"?: unknown;
    "cptr/activity"?: { type?: string };
    "cptr/prompt"?: { ticket?: string };
    "cptr/workspaces"?: Array<Record<string, unknown>>;
  } | undefined;
  assert.equal(initialMeta?.ui, undefined);
  assert.equal(initialMeta?.["cptr/live"], undefined);
  assert.equal(initialMeta?.["cptr/activity"]?.type, "mcp.tool");
  assert.equal(workspaceRequests, 1);
  assert.deepEqual(initialMeta?.["cptr/workspaces"], [
    { workspace_id: "ws-1", name: "Fixture", available: true, last_used_at: 1 },
  ]);
  assert.equal("path" in (initialMeta?.["cptr/workspaces"]?.[0] ?? {}), false);
  const promptTicket = initialMeta?.["cptr/prompt"]?.ticket;
  assert.ok(promptTicket);

  const taskResponse = await client.callTool({
    name: "cptr_start_task",
    arguments: {
      workspace_id: "ws-1",
      prompt: "Run the bounded fixture test allow:delegate using Bearer top-secret-value",
      model_id: "provider/model-1",
    },
  });
  const taskMeta = taskResponse._meta as {
    ui?: { resourceUri?: string };
    "cptr/live"?: unknown;
  } | undefined;
  assert.equal(taskMeta?.ui, undefined);
  assert.equal(taskMeta?.["cptr/live"], undefined);
  const taskReplay = promptSessions.replay(promptTicket, 0);
  assert.ok(taskReplay);
  const taskEvents = taskReplay.events.filter((event) => event.type === "mcp.tool" && event.payload.tool_name === "cptr_start_task");
  assert.deepEqual(taskEvents.map((event) => event.type === "mcp.tool" ? event.payload.status : ""), ["STARTED", "COMPLETE"]);
  const startedEvent = taskEvents[0];
  const completedEvent = taskEvents[1];
  assert.equal(startedEvent?.type, "mcp.tool");
  assert.equal(completedEvent?.type, "mcp.tool");
  if (startedEvent?.type === "mcp.tool") {
    assert.match(startedEvent.payload.arguments_json ?? "", /\"workspace_id\": \"ws-1\"/);
    assert.match(startedEvent.payload.arguments_json ?? "", /\"model_id\": \"provider\/model-1\"/);
    assert.match(startedEvent.payload.arguments_json ?? "", /Bearer \[REDACTED\]/);
    assert.equal((startedEvent.payload.arguments_json ?? "").includes("top-secret-value"), false);
  }
  if (completedEvent?.type === "mcp.tool") {
    assert.match(completedEvent.payload.result_json ?? "", /\"id\": \"task-1\"/);
    assert.equal((completedEvent.payload.result_json ?? "").includes("server-only-token"), false);
  }
  const taskBind = taskReplay.events.find((event) => event.type === "live.bind");
  assert.equal(taskBind?.type, "live.bind");
  if (taskBind?.type === "live.bind") {
    assert.equal(taskBind.payload.live.targetType, "task");
    assert.equal(taskBind.payload.live.targetId, "task-1");
  }
  assert.ok(taskEvents[0]!.sequence < taskBind!.sequence, "tool start must stream before target binding");
  assert.ok(taskBind!.sequence < taskEvents[1]!.sequence, "tool completion must stream after target binding");

  const response = await client.callTool({
    name: "cptr_render_live_terminal",
    arguments: {
      target_type: "task",
      target_id: "task-1",
      presentation: { mode: "inline" },
    },
  });
  const text = JSON.stringify(response.content);
  assert.match(text, /task-1/);
  assert.equal(text.includes("server-only-token"), false);
  const structured = response.structuredContent as {
    recent_events?: Array<{ sequence?: number }>;
  } | undefined;
  assert.equal(structured?.recent_events?.length, 20);
  assert.equal(structured?.recent_events?.[0]?.sequence, 6);
  assert.equal(structured?.recent_events?.at(-1)?.sequence, 25);
  const meta = response._meta as {
    ui?: { presentation?: Record<string, unknown> };
    "cptr/live"?: unknown;
  } | undefined;
  assert.deepEqual(meta?.ui?.presentation, { mode: "inline" });
  assert.equal(meta?.["cptr/live"], undefined);
  const renderReplay = promptSessions.replay(promptTicket, taskReplay.last_sequence);
  assert.ok(renderReplay);
  const renderBind = renderReplay.events.find((event) => event.type === "live.bind");
  assert.equal(renderBind?.type, "live.bind");
  if (renderBind?.type === "live.bind") {
    assert.equal(renderBind.payload.live.targetType, "task");
    assert.equal(renderBind.payload.live.targetId, "task-1");
    assert.equal(renderBind.payload.live.ticket.includes("server-only-token"), false);
  }

  await client.close();
  await server.close();
});

test("applies byte-equivalent workspace scope to normal MCP task-creation entry points", async () => {
  const requestBodies: Array<Record<string, unknown>> = [];
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "server-only-token",
    fetchImpl: async (url, init) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith("/workbench-sessions")) {
        return new Response(JSON.stringify({
          session_id: "wbs_session_00000002",
          name: "Scope fixture",
          status: "OPEN",
          workspace_id: null,
          active_target_type: null,
          active_target_id: null,
          active_workspace_id: null,
          event_count: 0,
          created_at: 1,
          updated_at: 1,
          last_event_at: null,
          archived_at: null,
        }), { status: 200 });
      }
      if (requestUrl.includes("/workspaces?")) {
        return new Response(JSON.stringify({ workspaces: [] }), { status: 200 });
      }
      if (requestUrl.endsWith("/tasks")) {
        requestBodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({
          id: `task-scoped-${requestBodies.length}`,
          status: "COMPLETE",
          workspace_id: "ws-1",
          output: "Scoped fixture complete.",
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "task-scoped-1", status: "COMPLETE", workspace_id: "ws-1" }), { status: 200 });
    },
  });
  const server = createMcpServer(computer);
  const client = new Client({ name: "mcp-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  await authorizeDelegation(client);

  const input = {
    workspace_id: "ws-1",
    prompt: "Create CHATGPT_LIVE_WORKBENCH_OK.txt with the requested marker, then wait for steering. allow:delegate",
    model_id: "provider/heidi-antigravity",
  };
  await client.callTool({ name: "cptr_start_task", arguments: input });
  await client.callTool({ name: "cptr_execute_task", arguments: { ...input, wait_seconds: 1 } });

  assert.equal(requestBodies.length, 2);
  assert.deepEqual(requestBodies[0]?.execution_policy, {
    allow_file_writes: true,
    allow_commands: true,
    allow_network: false,
    allow_package_install: false,
  });
  assert.deepEqual(requestBodies[1]?.execution_policy, requestBodies[0]?.execution_policy);
  assert.equal(requestBodies[0]?.prompt, requestBodies[1]?.prompt);
  assert.match(String(requestBodies[0]?.prompt), /inspection_scope=workspace/);
  assert.doesNotMatch(String(requestBodies[0]?.prompt), /inspection_scope=assignment/);
  assert.match(String(requestBodies[0]?.prompt), /CHATGPT_LIVE_WORKBENCH_OK\.txt/);

  await client.close();
  await server.close();
});


test("preserves an explicitly requested narrow assignment scope", async () => {
  const requestBodies: Array<Record<string, unknown>> = [];
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "server-only-token",
    fetchImpl: async (url, init) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith("/workbench-sessions")) {
        return new Response(JSON.stringify({
          session_id: "wbs_session_00000003",
          name: "Narrow scope fixture",
          status: "OPEN",
          workspace_id: null,
          active_target_type: null,
          active_target_id: null,
          active_workspace_id: null,
          event_count: 0,
          created_at: 1,
          updated_at: 1,
          last_event_at: null,
          archived_at: null,
        }), { status: 200 });
      }
      if (requestUrl.includes("/workspaces?")) {
        return new Response(JSON.stringify({ workspaces: [] }), { status: 200 });
      }
      if (requestUrl.endsWith("/tasks")) {
        requestBodies.push(JSON.parse(String(init?.body)));
      }
      return new Response(JSON.stringify({
        id: "task-narrow",
        status: "COMPLETE",
        workspace_id: "ws-1",
        output: "Scoped fixture complete.",
      }), { status: 200 });
    },
  });
  const server = createMcpServer(computer);
  const client = new Client({ name: "mcp-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  await authorizeDelegation(client);

  const prompt = "inspection_scope=assignment. Only inspect fixture.txt. allow:delegate";
  await client.callTool({
    name: "cptr_start_task",
    arguments: { workspace_id: "ws-1", prompt, model_id: "provider/heidi-antigravity" },
  });

  assert.equal(requestBodies.length, 1);
  assert.equal(requestBodies[0]?.prompt, prompt);

  await client.close();
  await server.close();
});

test("does not delegate ChatGPT work to a CPTR model without explicit opt-in", async () => {
  let requestCount = 0;
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "server-only-token",
    fetchImpl: async () => {
      requestCount += 1;
      return new Response(JSON.stringify({}), { status: 200 });
    },
  });
  const server = createMcpServer(computer);
  const client = new Client({ name: "mcp-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const response = await client.callTool({
    name: "cptr_start_task",
    arguments: { workspace_id: "ws-1", prompt: "Audit this workspace", model_id: "provider/heidi-antigravity" },
  });

  assert.equal(response.isError, true);
  assert.match(JSON.stringify(response.content), /allow:delegate/i);
  assert.equal(requestCount, 0);

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
  await authorizeDelegation(client);

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
        diff: {
          files: [{ path: "src/app.ts", hunks: [] }],
          max_bytes: 100_000,
          bytes_returned: 42,
          truncated: false,
          omitted_paths: [],
        },
        review_available: true,
      }), { status: 200 });
    },
  });
  const server = createMcpServer(computer);
  const client = new Client({ name: "mcp-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  await authorizeDelegation(client);

  const response = await client.callTool({
    name: "cptr_get_task_review",
    arguments: { task_id: "task-review" },
  });

  assert.equal(response.isError, undefined);
  assert.equal(requestUrl.endsWith("/tasks/task-review/review?max_diff_bytes=100000"), true);
  assert.deepEqual(response.structuredContent, {
    task_id: "task-review",
    workspace_id: "ws-1",
    status: "REVIEW_REQUIRED",
    review: { status: "REQUIRED", summary: { file_count: 1 } },
    diff: {
      files: [{ path: "src/app.ts", hunks: [] }],
      max_bytes: 100_000,
      bytes_returned: 42,
      truncated: false,
      omitted_paths: [],
    },
    review_available: true,
  });

  await client.close();
  await server.close();
});
