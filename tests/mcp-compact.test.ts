import assert from "node:assert/strict";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { ComputerClient } from "../server/client/computer-client.js";
import { LiveTicketStore } from "../server/live-tickets.js";
import { createMcpServer, getMcpToolSurfaceProfile, resolveMcpToolSurface } from "../server/mcp.js";
import { PromptTerminalStore } from "../server/prompt-terminal.js";

const COMPACT_TOOL_NAMES = [
  "cptr_agent_monitor",
  "cptr_agent_task",
  "cptr_benchmark",
  "cptr_chrome_browser",
  "cptr_code",
  "cptr_command",
  "cptr_factory",
  "cptr_fdx_intelligence",
  "cptr_lsp",
  "cptr_memory",
  "cptr_open_live_workbench",
  "cptr_plugin_update",
  "cptr_render_live_terminal",
  "cptr_ssh",
  "cptr_user_chrome",
  "cptr_workbench",
  "cptr_worker",
  "cptr_workspace",
].sort();

test("MCP tool-surface configuration defaults legacy and rejects unknown values", () => {
  assert.equal(resolveMcpToolSurface(undefined), "legacy");
  assert.equal(resolveMcpToolSurface("legacy"), "legacy");
  assert.equal(resolveMcpToolSurface("compact"), "compact");
  assert.throws(() => resolveMcpToolSurface("unknown"), /CPTR_MCP_TOOL_SURFACE/);
});

async function connectedServer(computer: ComputerClient, toolSurface: "legacy" | "compact") {
  const server = createMcpServer(computer, { toolSurface } as never);
  const client = new Client({ name: "compact-contract-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

test("compact MCP surface exposes 18 domain tools under 100 KB while legacy stays intact", async () => {
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async () => new Response(JSON.stringify({}), { status: 200 }),
  });

  const compact = await connectedServer(computer, "compact");
  const compactListed = await compact.client.listTools();
  assert.deepEqual(compactListed.tools.map((tool) => tool.name).sort(), COMPACT_TOOL_NAMES);
  assert.ok(Buffer.byteLength(JSON.stringify(compactListed)) < 100_000);
  assert.equal(getMcpToolSurfaceProfile(compact.server)?.registered_tools, 18);
  assert.equal(getMcpToolSurfaceProfile(compact.server)?.delegated_tools, 2);
  for (const tool of compactListed.tools) {
    const input = tool.inputSchema as {
      properties?: Record<string, { enum?: string[] }>;
    };
    assert.notEqual(input.properties?.client_model, undefined, `${tool.name} must keep client_model`);
  }
  const compactTools = new Map(compactListed.tools.map((tool) => [tool.name, tool]));
  const workspaceAction = (compactTools.get("cptr_workspace")?.inputSchema as {
    properties?: { action?: { enum?: string[] } };
  }).properties?.action;
  assert.ok(workspaceAction?.enum?.includes("create"));
  assert.match(compactTools.get("cptr_workspace")?.description ?? "", /create\(path/);
  assert.match(compactTools.get("cptr_command")?.description ?? "", /run\(workspace_id,command/);
  await compact.client.close();
  await compact.server.close();

  const legacy = await connectedServer(computer, "legacy");
  assert.equal((await legacy.client.listTools()).tools.length, 91);
  assert.equal(getMcpToolSurfaceProfile(legacy.server)?.registered_tools, 91);
  await legacy.client.close();
  await legacy.server.close();
});

test("compact delegated domains remain blocked until prompt-scoped allow:delegate is opened", async () => {
  let modelRequests = 0;
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async (url) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith("/models")) modelRequests += 1;
      if (requestUrl.endsWith("/workbench-sessions")) {
        return new Response(JSON.stringify({
          session_id: "wbs_compact_00000001",
          name: "Compact delegation fixture",
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
  const { server, client } = await connectedServer(computer, "compact");

  const blockedBeforeOpen = await client.callTool({
    name: "cptr_agent_task",
    arguments: { action: "models", payload: {} },
  });
  assert.equal(blockedBeforeOpen.isError, true);
  assert.match(JSON.stringify(blockedBeforeOpen.content), /allow:delegate/);
  assert.equal(modelRequests, 0);

  await client.callTool({ name: "cptr_open_live_workbench", arguments: {} });
  const blockedDirect = await client.callTool({
    name: "cptr_agent_task",
    arguments: { action: "models", payload: {} },
  });
  assert.equal(blockedDirect.isError, true);
  assert.equal(modelRequests, 0);

  await client.callTool({
    name: "cptr_open_live_workbench",
    arguments: { delegation_authorization: "allow:delegate" },
  });
  const allowed = await client.callTool({
    name: "cptr_agent_task",
    arguments: { action: "models", payload: {} },
  });
  assert.equal(allowed.isError, undefined);
  assert.equal(modelRequests, 1);

  await client.close();
  await server.close();
});

test("compact workspace inspection maps actions onto the existing inspect endpoint semantics", async () => {
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async () => new Response(JSON.stringify({}), { status: 200 }),
  });
  let captured: unknown = null;
  (computer as any).inspectWorkspace = async (input: unknown) => {
    captured = structuredClone(input);
    return { ok: true };
  };
  const { server, client } = await connectedServer(computer, "compact");

  const result = await client.callTool({
    name: "cptr_workspace",
    arguments: {
      action: "detect_project",
      payload: { workspace_id: "workspace-1", worker_id: "worker-1" },
    },
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(captured, {
    workspace_id: "workspace-1",
    worker_id: "worker-1",
    kind: "project",
  });

  await client.close();
  await server.close();
});

test("compact command run preserves durable Workbench command binding", async () => {
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async () => new Response(JSON.stringify({}), { status: 200 }),
  });
  (computer as any).listWorkspaces = async () => ({ workspaces: [] });
  (computer as any).createWorkbenchSession = async () => ({
    session_id: "wbs_compact_command_0001",
    name: "Compact command",
    status: "OPEN",
    workspace_id: "workspace-1",
    active_target_type: null,
    active_target_id: null,
    active_workspace_id: null,
    event_count: 0,
    created_at: 1,
    updated_at: 1,
    last_event_at: null,
    archived_at: null,
  });
  (computer as any).runCodingCommand = async () => ({
    command_id: "cmd-1",
    status: "RUNNING",
    output: "",
    output_offset: 0,
    next_offset: 0,
    output_truncated: false,
  });
  let binding: unknown = null;
  (computer as any).bindWorkbenchSession = async (input: unknown) => {
    binding = structuredClone(input);
    return {};
  };
  const { server, client } = await connectedServer(computer, "compact");
  const opened = await client.callTool({
    name: "cptr_open_live_workbench",
    arguments: { session_name: "Compact command", workspace_id: "workspace-1" },
  });
  const sessionId = (opened.structuredContent as { session_id: string }).session_id;

  const result = await client.callTool({
    name: "cptr_command",
    arguments: {
      action: "run",
      payload: {
        workspace_id: "workspace-1",
        command: "printf compact",
        workbench_session_id: sessionId,
      },
    },
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(binding, {
    session_id: "wbs_compact_command_0001",
    target_type: "command",
    target_id: "cmd-1",
    workspace_id: "workspace-1",
  });

  await client.close();
  await server.close();
});

test("compact command run_test preserves legacy Workbench binding, activity, and prompt live.bind", async () => {
  const promptSessions = new PromptTerminalStore({ streamingEnabled: true });
  const tickets = new LiveTicketStore();
  const appended: Array<Record<string, unknown>> = [];
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async () => new Response(JSON.stringify({}), { status: 200 }),
  });
  (computer as any).listWorkspaces = async () => ({ workspaces: [] });
  (computer as any).createWorkbenchSession = async () => ({
    session_id: "wbs_compact_test_00000001",
    name: "Compact test",
    status: "OPEN",
    workspace_id: "workspace-1",
    active_target_type: null,
    active_target_id: null,
    active_workspace_id: null,
    event_count: 0,
    created_at: 1,
    updated_at: 1,
    last_event_at: null,
    archived_at: null,
  });
  (computer as any).runWorkspaceTestTarget = async () => ({
    target: "node_test",
    command_id: "cmd-test-1",
    status: "RUNNING",
    exit_code: null,
    output: "",
    next_offset: 0,
  });
  let binding: unknown = null;
  (computer as any).bindWorkbenchSession = async (input: unknown) => {
    binding = structuredClone(input);
    return {};
  };
  (computer as any).appendWorkbenchSessionEvent = async (input: Record<string, unknown>) => {
    appended.push(structuredClone(input));
    return { sequence: appended.length, ...input };
  };

  const server = createMcpServer(computer, { toolSurface: "compact", promptSessions, tickets } as never);
  const client = new Client({ name: "compact-run-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const opened = await client.callTool({
    name: "cptr_open_live_workbench",
    arguments: { session_name: "Compact test", workspace_id: "workspace-1" },
  });
  const sessionId = (opened.structuredContent as { session_id?: string } | undefined)?.session_id;
  const promptTicket = (opened._meta as { "cptr/prompt"?: { ticket?: string } } | undefined)?.["cptr/prompt"]?.ticket;
  assert.ok(sessionId);
  assert.ok(promptTicket);

  const response = await client.callTool({
    name: "cptr_command",
    arguments: {
      action: "run_test",
      payload: {
        workspace_id: "workspace-1",
        target: "node_test",
        workbench_session_id: sessionId,
      },
    },
  });
  assert.equal(response.isError, undefined);
  assert.deepEqual(binding, {
    session_id: "wbs_compact_test_00000001",
    target_type: "command",
    target_id: "cmd-test-1",
    workspace_id: "workspace-1",
  });
  assert.equal(appended.at(-1)?.event_type, "test_profile.started");
  assert.equal(appended.at(-1)?.target_id, "cmd-test-1");

  const replay = promptSessions.replay(promptTicket!, 0);
  const bind = replay?.events.find((event) => event.type === "live.bind");
  assert.equal(bind?.type, "live.bind");
  if (bind?.type === "live.bind") {
    assert.equal(bind.payload.live.targetType, "command");
    assert.equal(bind.payload.live.targetId, "cmd-test-1");
    assert.equal(bind.payload.live.workspaceId, "workspace-1");
  }

  await client.close();
  await server.close();
});

test("compact worker run and run_test preserve real Workbench command live.bind", async () => {
  const promptSessions = new PromptTerminalStore({ streamingEnabled: true });
  const tickets = new LiveTicketStore();
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async () => new Response(JSON.stringify({}), { status: 200 }),
  });
  (computer as any).listWorkspaces = async () => ({ workspaces: [] });
  (computer as any).createWorkbenchSession = async () => ({
    session_id: "wbs_compact_worker_live_01",
    name: "Compact worker live",
    status: "OPEN",
    workspace_id: "workspace-1",
    active_target_type: null,
    active_target_id: null,
    active_workspace_id: null,
    event_count: 0,
    created_at: 1,
    updated_at: 1,
    last_event_at: null,
    archived_at: null,
  });
  let nextCommandId = "cmd-worker-run";
  (computer as any).runCodingCommand = async () => ({
    command_id: nextCommandId,
    status: "RUNNING",
    exit_code: null,
    output: "",
    next_offset: 0,
    output_offset: 0,
    output_truncated: false,
  });
  (computer as any).runWorkspaceTestTarget = async () => ({
    target: "node_test",
    command_id: "cmd-worker-test",
    status: "RUNNING",
    exit_code: null,
    output: "",
    next_offset: 0,
  });
  const bindings: Array<Record<string, unknown>> = [];
  (computer as any).bindWorkbenchSession = async (input: Record<string, unknown>) => {
    bindings.push(structuredClone(input));
    return {};
  };
  (computer as any).appendWorkbenchSessionEvent = async (input: Record<string, unknown>) => ({ sequence: 1, ...input });

  const server = createMcpServer(computer, { toolSurface: "compact", promptSessions, tickets } as never);
  const client = new Client({ name: "compact-worker-live", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const opened = await client.callTool({ name: "cptr_open_live_workbench", arguments: {} });
  const sessionId = (opened.structuredContent as { session_id?: string } | undefined)?.session_id;
  const promptTicket = (opened._meta as { "cptr/prompt"?: { ticket?: string } } | undefined)?.["cptr/prompt"]?.ticket;
  assert.ok(sessionId);
  assert.ok(promptTicket);

  await client.callTool({
    name: "cptr_command",
    arguments: {
      action: "run",
      payload: {
        workspace_id: "workspace-1",
        worker_id: "dcw-live",
        command: "printf worker",
        workbench_session_id: sessionId,
      },
    },
  });
  nextCommandId = "unused";
  await client.callTool({
    name: "cptr_command",
    arguments: {
      action: "run_test",
      payload: {
        workspace_id: "workspace-1",
        worker_id: "dcw-live",
        target: "node_test",
        workbench_session_id: sessionId,
      },
    },
  });

  assert.deepEqual(bindings.map((binding) => binding.target_id), ["cmd-worker-run", "cmd-worker-test"]);
  const binds = promptSessions.replay(promptTicket!, 0)?.events.filter((event) => event.type === "live.bind") ?? [];
  assert.deepEqual(
    binds.map((event) => event.type === "live.bind" ? event.payload.live.targetId : null),
    ["cmd-worker-run", "cmd-worker-test"],
    "compact worker commands must select the real command SSE targets exactly like the legacy worker tools",
  );

  await client.close();
  await server.close();
});

test("compact command follow-ups preserve non-worker prompt live.bind", async () => {
  const promptSessions = new PromptTerminalStore({ streamingEnabled: true });
  const tickets = new LiveTicketStore();
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async () => new Response(JSON.stringify({}), { status: 200 }),
  });
  (computer as any).listWorkspaces = async () => ({ workspaces: [] });
  (computer as any).createWorkbenchSession = async () => ({
    session_id: "wbs_compact_follow_000001",
    name: "Compact follow-up",
    status: "OPEN",
    workspace_id: "workspace-1",
    active_target_type: null,
    active_target_id: null,
    active_workspace_id: null,
    event_count: 0,
    created_at: 1,
    updated_at: 1,
    last_event_at: null,
    archived_at: null,
  });
  const commandResult = {
    command_id: "cmd-follow-1",
    status: "RUNNING",
    exit_code: null,
    output: "",
    next_offset: 0,
    output_offset: 0,
    output_truncated: false,
  };
  (computer as any).getCodingCommand = async () => commandResult;
  (computer as any).cancelCodingCommand = async () => commandResult;
  (computer as any).sendCodingCommandInput = async () => commandResult;
  (computer as any).resizeCodingCommand = async () => commandResult;
  (computer as any).signalCodingCommand = async () => commandResult;

  const server = createMcpServer(computer, { toolSurface: "compact", promptSessions, tickets } as never);
  const client = new Client({ name: "compact-command-follow", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const opened = await client.callTool({ name: "cptr_open_live_workbench", arguments: {} });
  const promptTicket = (opened._meta as { "cptr/prompt"?: { ticket?: string } } | undefined)?.["cptr/prompt"]?.ticket;
  assert.ok(promptTicket);

  const actions: Array<[string, Record<string, unknown>]> = [
    ["status", {}],
    ["cancel", {}],
    ["input", { data: "x" }],
    ["resize", { rows: 30, cols: 100 }],
    ["signal", { signal: "interrupt" }],
  ];
  for (const [action, extra] of actions) {
    const beforeReplay = promptSessions.replay(promptTicket!, 0);
    const before: number = beforeReplay?.events.filter((event) => event.type === "live.bind").length ?? 0;
    const response = await client.callTool({
      name: "cptr_command",
      arguments: {
        action,
        payload: { workspace_id: "workspace-1", command_id: "cmd-follow-1", ...extra },
      },
    });
    assert.equal(response.isError, undefined, `${action} should complete`);
    const afterReplay = promptSessions.replay(promptTicket!, 0);
    assert.ok(afterReplay);
    const binds = afterReplay.events.filter((event) => event.type === "live.bind");
    assert.equal(binds.length, before + 1, `${action} should append one live.bind`);
    const bind = binds.at(-1);
    if (bind?.type === "live.bind") {
      assert.equal(bind.payload.live.targetType, "command");
      assert.equal(bind.payload.live.targetId, "cmd-follow-1");
      assert.equal(bind.payload.live.workspaceId, "workspace-1");
    }
  }

  await client.close();
  await server.close();
});

test("compact SSH actions preserve legacy prompt command binding", async () => {
  const promptSessions = new PromptTerminalStore({ streamingEnabled: true });
  const tickets = new LiveTicketStore();
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async () => new Response(JSON.stringify({}), { status: 200 }),
  });
  (computer as any).listWorkspaces = async () => ({ workspaces: [] });
  (computer as any).createWorkbenchSession = async () => ({
    session_id: "wbs_compact_ssh_00000001",
    name: "Compact SSH",
    status: "OPEN",
    workspace_id: "workspace-1",
    active_target_type: null,
    active_target_id: null,
    active_workspace_id: null,
    event_count: 0,
    created_at: 1,
    updated_at: 1,
    last_event_at: null,
    archived_at: null,
  });
  const sshResult = {
    workspace_id: "workspace-1",
    alias: "host-a",
    command_id: "ssh-cmd-1",
    status: "RUNNING",
    exit_code: null,
    output: "",
    next_offset: 0,
  };
  (computer as any).runSshCommand = async () => sshResult;
  (computer as any).getSshCommand = async () => sshResult;
  (computer as any).cancelSshCommand = async () => sshResult;

  const server = createMcpServer(computer, { toolSurface: "compact", promptSessions, tickets } as never);
  const client = new Client({ name: "compact-ssh", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const opened = await client.callTool({ name: "cptr_open_live_workbench", arguments: {} });
  const promptTicket = (opened._meta as { "cptr/prompt"?: { ticket?: string } } | undefined)?.["cptr/prompt"]?.ticket;
  assert.ok(promptTicket);

  const calls: Array<[string, Record<string, unknown>]> = [
    ["run", { alias: "host-a", command: "true" }],
    ["status", { command_id: "ssh-cmd-1" }],
    ["cancel", { command_id: "ssh-cmd-1" }],
  ];
  for (const [action, extra] of calls) {
    const beforeReplay = promptSessions.replay(promptTicket!, 0);
    const before: number = beforeReplay?.events.filter((event) => event.type === "live.bind").length ?? 0;
    const response = await client.callTool({
      name: "cptr_ssh",
      arguments: { action, payload: { workspace_id: "workspace-1", ...extra } },
    });
    assert.equal(response.isError, undefined, `${action} should complete`);
    const afterReplay = promptSessions.replay(promptTicket!, 0);
    assert.ok(afterReplay);
    const binds = afterReplay.events.filter((event) => event.type === "live.bind");
    assert.equal(binds.length, before + 1, `${action} should append one live.bind`);
    const bind = binds.at(-1);
    if (bind?.type === "live.bind") {
      assert.equal(bind.payload.live.targetType, "command");
      assert.equal(bind.payload.live.targetId, "ssh-cmd-1");
      assert.equal(bind.payload.live.workspaceId, "workspace-1");
    }
  }

  await client.close();
  await server.close();
});

test("compact delegated starts preserve legacy Workbench activity and prompt live.bind", async () => {
  const promptSessions = new PromptTerminalStore({ streamingEnabled: true });
  const tickets = new LiveTicketStore();
  const appended: Array<Record<string, unknown>> = [];
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async () => new Response(JSON.stringify({}), { status: 200 }),
  });
  (computer as any).listWorkspaces = async () => ({ workspaces: [] });
  (computer as any).createWorkbenchSession = async () => ({
    session_id: "wbs_compact_delegate_0001",
    name: "Compact delegate",
    status: "OPEN",
    workspace_id: "workspace-1",
    active_target_type: null,
    active_target_id: null,
    active_workspace_id: null,
    event_count: 0,
    created_at: 1,
    updated_at: 1,
    last_event_at: null,
    archived_at: null,
  });
  (computer as any).bindWorkbenchSession = async () => ({});
  (computer as any).appendWorkbenchSessionEvent = async (input: Record<string, unknown>) => {
    appended.push(structuredClone(input));
    return { sequence: appended.length, ...input };
  };
  (computer as any).startTask = async () => ({ id: "task-start-1", workspace_id: "workspace-1", status: "RUNNING" });
  (computer as any).executeTask = async () => ({
    task_id: "task-exec-1",
    workspace_id: "workspace-1",
    status: "RUNNING",
    output: "",
    output_truncated: false,
    completed: false,
    wait_seconds: 1,
  });
  (computer as any).createAutonomous = async () => ({ monitor_id: "monitor-1", workspace_id: "workspace-1", status: "RUNNING" });

  const server = createMcpServer(computer, { toolSurface: "compact", promptSessions, tickets } as never);
  const client = new Client({ name: "compact-delegated-live", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const opened = await client.callTool({
    name: "cptr_open_live_workbench",
    arguments: { delegation_authorization: "allow:delegate" },
  });
  const sessionId = (opened.structuredContent as { session_id?: string } | undefined)?.session_id;
  const promptTicket = (opened._meta as { "cptr/prompt"?: { ticket?: string } } | undefined)?.["cptr/prompt"]?.ticket;
  assert.ok(sessionId);
  assert.ok(promptTicket);

  await client.callTool({
    name: "cptr_agent_task",
    arguments: { action: "start", payload: { workspace_id: "workspace-1", prompt: "start", workbench_session_id: sessionId } },
  });
  await client.callTool({
    name: "cptr_agent_task",
    arguments: { action: "execute", payload: { workspace_id: "workspace-1", prompt: "execute", workbench_session_id: sessionId } },
  });
  await client.callTool({
    name: "cptr_agent_monitor",
    arguments: {
      action: "start",
      payload: {
        workspace_id: "workspace-1",
        goal: "monitor",
        acceptance_criteria: ["done"],
        workbench_session_id: sessionId,
      },
    },
  });

  assert.deepEqual(
    appended.map((event) => event.event_type),
    ["task.started", "task.executed", "monitor.started"],
  );
  const binds = promptSessions.replay(promptTicket!, 0)?.events.filter((event) => event.type === "live.bind") ?? [];
  assert.deepEqual(
    binds.map((event) => event.type === "live.bind" ? [event.payload.live.targetType, event.payload.live.targetId] : []),
    [["task", "task-start-1"], ["task", "task-exec-1"], ["monitor", "monitor-1"]],
  );

  await client.close();
  await server.close();
});

test("ComputerClient workspace creation posts to the Control API and invalidates cached workspace discovery", async () => {
  let listRequests = 0;
  let createRequests = 0;
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async (url, init) => {
      const requestUrl = String(url);
      if (requestUrl.includes("/workspaces?")) {
        listRequests += 1;
        return new Response(JSON.stringify({ workspaces: [] }), { status: 200 });
      }
      if (requestUrl.endsWith("/workspaces") && init?.method === "POST") {
        createRequests += 1;
        return new Response(JSON.stringify({
          workspace_id: "workspace-new",
          name: "Demo",
          available: true,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    },
  });

  await computer.listWorkspaces(false);
  await computer.listWorkspaces(false);
  assert.equal(listRequests, 1, "workspace discovery should be cached before mutation");
  await computer.createWorkspace({ path: "/approved/demo", name: "Demo" });
  assert.equal(createRequests, 1);
  await computer.listWorkspaces(false);
  assert.equal(listRequests, 2, "workspace creation must invalidate cached discovery");
});

test("cptr_workspace compact create dispatches to the authoritative workspace client method", async () => {
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async () => new Response(JSON.stringify({}), { status: 200 }),
  });
  let captured: unknown = null;
  (computer as unknown as { createWorkspace: (input: unknown) => Promise<Record<string, unknown>> }).createWorkspace = async (input) => {
    captured = structuredClone(input);
    return {
      workspace_id: "workspace-new",
      name: "Demo",
      available: true,
      is_git_repo: false,
      created_workspace: true,
      created_directory: false,
      initialized_git: false,
    };
  };

  const { server, client } = await connectedServer(computer, "compact");
  await client.callTool({
    name: "cptr_workspace",
    arguments: {
      action: "create",
      payload: {
        path: "/approved/demo",
        name: "Demo",
        create_directory: false,
        initialize_git: false,
      },
    },
  });
  assert.deepEqual(captured, {
    path: "/approved/demo",
    name: "Demo",
    create_directory: false,
    initialize_git: false,
  });

  await client.close();
  await server.close();
});
