import assert from "node:assert/strict";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { ComputerApiError, ComputerClient } from "../server/client/computer-client.js";
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

test("compact MCP surface exposes 17 backend-owned Workbench tools under 100 KB while legacy stays intact", async () => {
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async () => new Response(JSON.stringify({}), { status: 200 }),
  });

  const compact = await connectedServer(computer, "compact");
  const compactListed = await compact.client.listTools();
  assert.deepEqual(compactListed.tools.map((tool) => tool.name).sort(), COMPACT_TOOL_NAMES);
  assert.ok(Buffer.byteLength(JSON.stringify(compactListed)) < 100_000);
  assert.equal(getMcpToolSurfaceProfile(compact.server)?.registered_tools, 17);
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
  const codeAction = (compactTools.get("cptr_code")?.inputSchema as {
    properties?: { action?: { enum?: string[] } };
  }).properties?.action;
  assert.ok(codeAction?.enum?.includes("materialize_secret"));
  assert.match(compactTools.get("cptr_code")?.description ?? "", /allow:secret-write/);
  assert.match(compactTools.get("cptr_command")?.description ?? "", /# cptr-root: use root/);
  const factoryAction = (compactTools.get("cptr_factory")?.inputSchema as {
    properties?: { action?: { enum?: string[] } };
  }).properties?.action;
  for (const operation of ["inspect", "resolve", "forge", "execute", "acquire", "reflect"]) {
    assert.ok(factoryAction?.enum?.includes(operation), `cptr_factory must expose Capability OS ${operation}`);
  }
  assert.match(compactTools.get("cptr_factory")?.description ?? "", /Capability OS kernel/);
  assert.match(compactTools.get("cptr_factory")?.description ?? "", /omitted task_id defaults to the current authoritative Workbench session/);
  const update = await compact.client.callTool({
    name: "cptr_plugin_update",
    arguments: {
      action: "verify_server",
      expected_contract_version: "2026-07-28",
      expected_tool_count: 17,
    },
  });
  const updateValue = update.structuredContent as Record<string, unknown> | undefined;
  assert.equal(update.isError, undefined);
  assert.equal(updateValue?.tool_surface, "compact");
  assert.equal(updateValue?.contract_version, "2026-07-28");
  assert.equal(updateValue?.tool_count, 17);
  assert.equal(updateValue?.registered_tool_count, 17);
  assert.equal(updateValue?.core_tool_count, 84);
  assert.equal(updateValue?.legacy_registered_tool_count, 91);
  assert.equal(updateValue?.tool_count_matches, true);
  await compact.client.close();
  await compact.server.close();

  const legacy = await connectedServer(computer, "legacy");
  assert.equal((await legacy.client.listTools()).tools.length, 91);
  assert.equal(getMcpToolSurfaceProfile(legacy.server)?.registered_tools, 91);
  await legacy.client.close();
  await legacy.server.close();
});

test("compact Capability OS schema publishes bootstrap, digest, Forge, and Acquire invoke semantics", async () => {
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async () => new Response(JSON.stringify({}), { status: 200 }),
  });
  const { server, client } = await connectedServer(computer, "compact");
  const listed = await client.listTools();
  const factory = listed.tools.find((tool) => tool.name === "cptr_factory");
  assert.ok(factory);
  const description = factory.description ?? "";
  assert.match(description, /cptr_open_live_workbench.*bootstrap/i);
  assert.match(description, /contentDigest.*content-addressed Tool/i);
  assert.match(description, /capability_digest.*Capability artifact content digest/i);
  assert.match(description, /acquire.*invoke.*mountId.*tool.*inputs.*timeoutMs/i);

  const input = factory.inputSchema as {
    properties?: {
      payload?: {
        properties?: Record<string, unknown>;
      };
    };
  };
  const payloadProperties = input.properties?.payload?.properties ?? {};
  for (const field of [
    "task_id",
    "artifact_digest",
    "required",
    "forbidden",
    "operation",
    "payload",
    "capability_digest",
    "lease_id",
    "spec",
    "inputs",
    "approval_id",
    "kind",
    "claims",
  ]) {
    assert.ok(field in payloadProperties, `cptr_factory payload schema must publish ${field}`);
  }

  const nestedPayload = payloadProperties.payload as {
    properties?: Record<string, unknown>;
  } | undefined;
  const nestedProperties = nestedPayload?.properties ?? {};
  for (const field of [
    "contentDigest",
    "toolId",
    "runtimeClass",
    "entrypoint",
    "files",
    "requestedCapabilities",
    "artifactDigest",
    "goal",
    "query",
    "mountId",
    "tool",
    "inputs",
    "timeoutMs",
  ]) {
    assert.ok(field in nestedProperties, `Capability OS nested operation schema must publish ${field}`);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(listed)) < 100_000);
  await client.close();
  await server.close();
});

test("compact Capability OS errors use one canonical envelope", async () => {
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async () => new Response(JSON.stringify({}), { status: 200 }),
  });
  const { server, client } = await connectedServer(computer, "compact");

  (computer as any).capabilityOs = async () => {
    throw new ComputerApiError(409, "qualification rejected", "capability_conflict", false, "forbidden");
  };
  const backendFailure = await client.callTool({
    name: "cptr_factory",
    arguments: { action: "resolve", payload: { task_id: "task-1", required: [] } },
  });
  assert.equal(backendFailure.isError, true);
  const backendEnvelope = JSON.parse((backendFailure.content?.[0] as { text?: string })?.text ?? "{}");
  assert.deepEqual(backendEnvelope, {
    code: "capability_conflict",
    message: "qualification rejected",
    retriable: false,
    field: "forbidden",
  });

  (computer as any).capabilityOs = async () => {
    throw new Error("unexpected adapter failure");
  };
  const adapterFailure = await client.callTool({
    name: "cptr_factory",
    arguments: { action: "inspect", payload: { task_id: "task-1" } },
  });
  assert.equal(adapterFailure.isError, true);
  const adapterEnvelope = JSON.parse((adapterFailure.content?.[0] as { text?: string })?.text ?? "{}");
  assert.deepEqual(adapterEnvelope, {
    code: "mcp_tool_error",
    message: "unexpected adapter failure",
    retriable: false,
  });

  await client.close();
  await server.close();
});

test("compact Capability OS kernel defaults omitted task identity to the current Workbench and preserves explicit task IDs", async () => {
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async () => new Response(JSON.stringify({}), { status: 200 }),
  });
  const calls: Array<{ action: string; payload: Record<string, unknown> }> = [];
  (computer as any).capabilityOs = async (action: string, payload: Record<string, unknown>) => {
    calls.push({ action, payload: structuredClone(payload) });
    return { ok: true, action };
  };
  const { server, client } = await connectedServer(computer, "compact");
  const workbenchTaskId = "wbs_capability_00000001";
  const actions = ["inspect", "resolve", "forge", "execute", "acquire", "reflect"] as const;

  for (const action of actions) {
    const response = await client.callTool({
      name: "cptr_factory",
      arguments: {
        action,
        payload: { marker: action },
        workbench_session_id: workbenchTaskId,
      },
    });
    assert.equal(response.isError, undefined, `${action} should inherit the Workbench task identity`);
  }
  assert.deepEqual(calls, actions.map((action) => ({
    action,
    payload: { marker: action, task_id: workbenchTaskId },
  })));

  const explicit = await client.callTool({
    name: "cptr_factory",
    arguments: {
      action: "inspect",
      payload: { task_id: "task-capability", marker: "explicit" },
      workbench_session_id: workbenchTaskId,
    },
  });
  assert.equal(explicit.isError, undefined);
  assert.deepEqual(calls.at(-1), {
    action: "inspect",
    payload: { task_id: "task-capability", marker: "explicit" },
  });

  await client.close();
  await server.close();
});

test("compact secret materialization requires current prompt authorization and injects backend approval", async () => {
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async () => new Response(JSON.stringify({}), { status: 200 }),
  });
  (computer as any).listWorkspaces = async () => ({ workspaces: [] });
  (computer as any).createWorkbenchSession = async () => ({
    session_id: "wbs_secret_prompt_000001",
    name: "Secret prompt",
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
  let captured: unknown = null;
  (computer as any).materializeCodingSecret = async (input: unknown) => {
    captured = structuredClone(input);
    return {
      workspace_id: "workspace-1",
      path: ".env",
      scope: "workspace",
      materialized: true,
      permissions: "0600",
    };
  };
  const { server, client } = await connectedServer(computer, "compact");

  const blocked = await client.callTool({
    name: "cptr_code",
    arguments: {
      action: "materialize_secret",
      payload: {
        workspace_id: "workspace-1",
        path: ".env",
        secret: "PASSWORD=synthetic-test-secret",
        overwrite: true,
      },
    },
  });
  assert.equal(blocked.isError, true);
  assert.match(JSON.stringify(blocked.content), /secret-write/);
  assert.equal(captured, null);

  const opened = await client.callTool({
    name: "cptr_open_live_workbench",
    arguments: {
      workspace_id: "workspace-1",
      secret_write_authorization: "allow:secret-write",
    },
  });
  const sessionId = (opened.structuredContent as { session_id: string }).session_id;
  const response = await client.callTool({
    name: "cptr_code",
    arguments: {
      action: "materialize_secret",
      payload: {
        workspace_id: "workspace-1",
        path: ".env",
        secret: "PASSWORD=synthetic-test-secret",
        overwrite: true,
      },
      workbench_session_id: sessionId,
    },
  });

  assert.equal(response.isError, undefined);
  assert.deepEqual(captured, {
    workspace_id: "workspace-1",
    path: ".env",
    secret: "PASSWORD=synthetic-test-secret",
    workbench_session_id: "wbs_secret_prompt_000001",
    user_approval: "allow:secret-write",
    overwrite: true,
  });

  await client.close();
  await server.close();
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

test("compact stale workspace errors stay recoverable without poisoning the MCP surface", async () => {
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async (url) => {
      const requestUrl = String(url);
      if (requestUrl.includes("/workspaces/stale-workspace/coding/commands")) {
        return new Response(JSON.stringify({ detail: "workspace not found" }), { status: 404 });
      }
      if (requestUrl.includes("/workspaces?")) {
        return new Response(JSON.stringify({
          workspaces: [
            { workspace_id: "workspace-current", name: "current", available: true, last_used_at: 1 },
          ],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    },
  });
  const { server, client } = await connectedServer(computer, "compact");

  const stale = await client.callTool({
    name: "cptr_command",
    arguments: {
      action: "run",
      payload: { workspace_id: "stale-workspace", command: "pwd", allow_network: false },
    },
  });
  assert.equal(stale.isError, undefined);
  const staleValue = stale.structuredContent as {
    action?: string;
    result?: {
      ok?: boolean;
      error?: { code?: string; field?: string };
      recovery?: { tool?: string; action?: string };
    };
  } | undefined;
  assert.equal(staleValue?.action, "run");
  assert.equal(staleValue?.result?.ok, false);
  assert.equal(staleValue?.result?.error?.code, "workspace_not_found");
  assert.equal(staleValue?.result?.error?.field, "workspace_id");
  assert.deepEqual(staleValue?.result?.recovery, { tool: "cptr_workspace", action: "list" });

  const listed = await client.callTool({
    name: "cptr_workspace",
    arguments: { action: "list", payload: {} },
  });
  assert.equal(listed.isError, undefined);
  const listedValue = listed.structuredContent as { result?: { workspaces?: Array<{ workspace_id: string }> } };
  assert.equal(listedValue.result?.workspaces?.[0]?.workspace_id, "workspace-current");

  await client.close();
  await server.close();
});

test("compact Workbench opens one backend-owned live stream and command run does not rebind transport", async () => {
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
  let commandInput: unknown = null;
  (computer as any).runCodingCommand = async (input: unknown) => {
    commandInput = structuredClone(input);
    return {
      command_id: "cmd-1",
      status: "RUNNING",
      output: "",
      output_offset: 0,
      next_offset: 0,
      output_truncated: false,
    };
  };
  let binding: unknown = null;
  (computer as any).bindWorkbenchSession = async (input: unknown) => {
    binding = structuredClone(input);
    return {};
  };
  const promptSessions = new PromptTerminalStore({ streamingEnabled: true });
  const tickets = new LiveTicketStore();
  const server = createMcpServer(computer, { toolSurface: "compact", promptSessions, tickets } as never);
  const client = new Client({ name: "compact-workbench-live", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const opened = await client.callTool({
    name: "cptr_open_live_workbench",
    arguments: { session_name: "Compact command", workspace_id: "workspace-1" },
  });
  const sessionId = (opened.structuredContent as { session_id: string }).session_id;
  const live = (opened._meta as { "cptr/live"?: { targetType?: string; targetId?: string } } | undefined)?.["cptr/live"];
  const promptTicket = (opened._meta as { "cptr/prompt"?: { ticket?: string } } | undefined)?.["cptr/prompt"]?.ticket;
  assert.equal(live?.targetType, "workbench");
  assert.equal(live?.targetId, sessionId);
  assert.ok(promptTicket);

  const result = await client.callTool({
    name: "cptr_command",
    arguments: {
      action: "run",
      payload: {
        workspace_id: "workspace-1",
        command: "printf compact",
      },
      workbench_session_id: sessionId,
    },
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(commandInput, {
    workspace_id: "workspace-1",
    command: "printf compact",
    workbench_session_id: "wbs_compact_command_0001",
  });
  assert.equal(binding, null, "backend command creation must own target binding without a second plugin request");
  const binds = promptSessions.replay(promptTicket!, 0)?.events.filter((event) => event.type === "live.bind") ?? [];
  assert.equal(binds.length, 0, "normal command execution must not switch the Workbench transport");

  await client.close();
  await server.close();
});

test("compact command run_test forwards Workbench routing to the backend without plugin binding", async () => {
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
  let testInput: Record<string, unknown> | null = null;
  (computer as any).runWorkspaceTestTarget = async (input: Record<string, unknown>) => {
    testInput = structuredClone(input);
    return {
      target: "node_test",
      command_id: "cmd-test-1",
      status: "RUNNING",
      exit_code: null,
      output: "",
      next_offset: 0,
    };
  };
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
      },
      workbench_session_id: sessionId,
    },
  });
  assert.equal(response.isError, undefined);
  assert.deepEqual(testInput, {
    workspace_id: "workspace-1",
    target: "node_test",
    workbench_session_id: "wbs_compact_test_00000001",
  });
  assert.equal(binding, null, "backend test execution owns target association");
  assert.deepEqual(appended, [], "plugin must not synthesize backend lifecycle rows");
  const binds = promptSessions.replay(promptTicket!, 0)?.events.filter((event) => event.type === "live.bind") ?? [];
  assert.equal(binds.length, 0, "test execution must stay on the persistent Workbench transport");

  await client.close();
  await server.close();
});

test("compact worker run and run_test forward the same Workbench route without target switching", async () => {
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
  const commandInputs: Array<Record<string, unknown>> = [];
  const testInputs: Array<Record<string, unknown>> = [];
  (computer as any).runCodingCommand = async (input: Record<string, unknown>) => {
    commandInputs.push(structuredClone(input));
    return {
      command_id: nextCommandId,
      status: "RUNNING",
      exit_code: null,
      output: "",
      next_offset: 0,
      output_offset: 0,
      output_truncated: false,
    };
  };
  (computer as any).runWorkspaceTestTarget = async (input: Record<string, unknown>) => {
    testInputs.push(structuredClone(input));
    return {
      target: "node_test",
      command_id: "cmd-worker-test",
      status: "RUNNING",
      exit_code: null,
      output: "",
      next_offset: 0,
    };
  };
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
      },
      workbench_session_id: sessionId,
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
      },
      workbench_session_id: sessionId,
    },
  });

  assert.equal(commandInputs[0]?.workbench_session_id, "wbs_compact_worker_live_01");
  assert.equal(testInputs[0]?.workbench_session_id, "wbs_compact_worker_live_01");
  assert.deepEqual(bindings, [], "worker execution must bind only inside CPTR backend execution");
  const binds = promptSessions.replay(promptTicket!, 0)?.events.filter((event) => event.type === "live.bind") ?? [];
  assert.equal(binds.length, 0, "worker commands must not replace the persistent Workbench stream");

  await client.close();
  await server.close();
});

test("compact command follow-ups do not switch the persistent Workbench transport", async () => {
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
    assert.equal(binds.length, before, `${action} must not append live.bind`);
  }

  await client.close();
  await server.close();
});

test("compact SSH run forwards Workbench routing while SSH follow-ups keep the persistent transport", async () => {
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
  const sshRunInputs: Array<Record<string, unknown>> = [];
  (computer as any).runSshCommand = async (input: Record<string, unknown>) => {
    sshRunInputs.push(structuredClone(input));
    return sshResult;
  };
  (computer as any).getSshCommand = async () => sshResult;
  (computer as any).cancelSshCommand = async () => sshResult;

  const server = createMcpServer(computer, { toolSurface: "compact", promptSessions, tickets } as never);
  const client = new Client({ name: "compact-ssh", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const opened = await client.callTool({ name: "cptr_open_live_workbench", arguments: {} });
  const promptTicket = (opened._meta as { "cptr/prompt"?: { ticket?: string } } | undefined)?.["cptr/prompt"]?.ticket;
  assert.ok(promptTicket);

  const calls: Array<[string, Record<string, unknown>, string | undefined]> = [
    ["run", { alias: "host-a", command: "true" }, "wbs_compact_ssh_00000001"],
    ["status", { command_id: "ssh-cmd-1" }, undefined],
    ["cancel", { command_id: "ssh-cmd-1" }, undefined],
  ];
  for (const [action, extra, workbenchSessionId] of calls) {
    const beforeReplay = promptSessions.replay(promptTicket!, 0);
    const before: number = beforeReplay?.events.filter((event) => event.type === "live.bind").length ?? 0;
    const response = await client.callTool({
      name: "cptr_ssh",
      arguments: {
        action,
        payload: { workspace_id: "workspace-1", ...extra },
        ...(workbenchSessionId ? { workbench_session_id: workbenchSessionId } : {}),
      },
    });
    assert.equal(response.isError, undefined, `${action} should complete`);
    const afterReplay = promptSessions.replay(promptTicket!, 0);
    assert.ok(afterReplay);
    const binds = afterReplay.events.filter((event) => event.type === "live.bind");
    assert.equal(binds.length, before, `${action} must not append live.bind`);
  }
  assert.equal(sshRunInputs[0]?.workbench_session_id, "wbs_compact_ssh_00000001");

  await client.close();
  await server.close();
});

test("compact delegated starts forward Workbench routing to backend-owned task and monitor streams", async () => {
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
  const taskStarts: Array<Record<string, unknown>> = [];
  const taskExecutions: Array<Record<string, unknown>> = [];
  const monitorStarts: Array<Record<string, unknown>> = [];
  (computer as any).startTask = async (input: Record<string, unknown>) => {
    taskStarts.push(structuredClone(input));
    return { id: "task-start-1", workspace_id: "workspace-1", status: "RUNNING" };
  };
  (computer as any).executeTask = async (input: Record<string, unknown>) => {
    taskExecutions.push(structuredClone(input));
    return {
      task_id: "task-exec-1",
      workspace_id: "workspace-1",
      status: "RUNNING",
      output: "",
      output_truncated: false,
      completed: false,
      wait_seconds: 1,
    };
  };
  (computer as any).createAutonomous = async (input: Record<string, unknown>) => {
    monitorStarts.push(structuredClone(input));
    return { monitor_id: "monitor-1", workspace_id: "workspace-1", status: "RUNNING" };
  };

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
    arguments: { action: "start", payload: { workspace_id: "workspace-1", prompt: "start" }, workbench_session_id: sessionId },
  });
  await client.callTool({
    name: "cptr_agent_task",
    arguments: { action: "execute", payload: { workspace_id: "workspace-1", prompt: "execute" }, workbench_session_id: sessionId },
  });
  await client.callTool({
    name: "cptr_agent_monitor",
    arguments: {
      action: "start",
      payload: {
        workspace_id: "workspace-1",
        goal: "monitor",
        acceptance_criteria: ["done"],
      },
      workbench_session_id: sessionId,
    },
  });

  assert.equal(taskStarts[0]?.workbench_session_id, "wbs_compact_delegate_0001");
  assert.equal(taskExecutions[0]?.workbench_session_id, "wbs_compact_delegate_0001");
  assert.equal(monitorStarts[0]?.workbench_session_id, "wbs_compact_delegate_0001");
  assert.deepEqual(appended, [], "plugin must not synthesize delegated lifecycle rows");
  const binds = promptSessions.replay(promptTicket!, 0)?.events.filter((event) => event.type === "live.bind") ?? [];
  assert.equal(binds.length, 0, "delegated execution must stay on the persistent Workbench stream");

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
