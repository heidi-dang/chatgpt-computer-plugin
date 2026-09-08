import assert from "node:assert/strict";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { ComputerClient } from "../server/client/computer-client.js";
import { LiveTicketStore } from "../server/live-tickets.js";
import { createMcpServer } from "../server/mcp.js";
import { PromptTerminalStore } from "../server/prompt-terminal.js";

const workbenchSession = {
  session_id: "wbs_stateless_fixture_0001",
  name: "Stateless live fixture",
  workspace_id: null,
  status: "OPEN",
  active_target_type: null,
  active_target_id: null,
  active_workspace_id: null,
  event_count: 0,
  created_at: 1,
  updated_at: 1,
  last_event_at: null,
  archived_at: null,
};

function computerFixture(onAppendWorkbenchEvent?: () => void): ComputerClient {
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async () => new Response(JSON.stringify({}), { status: 200 }),
  });
  const mutable = computer as unknown as {
    listWorkspaces: () => Promise<{ workspaces: unknown[] }>;
    createWorkbenchSession: () => Promise<typeof workbenchSession>;
    getWorkbenchSession: () => Promise<typeof workbenchSession>;
    runCodingCommand: () => Promise<Record<string, unknown>>;
    getCodingCommand: () => Promise<Record<string, unknown>>;
    bindWorkbenchSession: () => Promise<Record<string, unknown>>;
    appendWorkbenchSessionEvent: () => Promise<Record<string, unknown>>;
  };
  mutable.listWorkspaces = async () => ({ workspaces: [] });
  mutable.createWorkbenchSession = async () => ({ ...workbenchSession });
  mutable.getWorkbenchSession = async () => ({ ...workbenchSession });
  mutable.runCodingCommand = async () => ({
    command_id: "command-stateless-1",
    status: "RUNNING",
    exit_code: null,
    output: "first live line\n",
    next_offset: 16,
    duration_ms: 1,
    output_truncated: false,
    timed_out: true,
  });
  mutable.getCodingCommand = async () => ({
    command_id: "command-stateless-1",
    status: "COMPLETE",
    exit_code: 0,
    output: "first live line\n",
    next_offset: 16,
    duration_ms: 42,
    output_truncated: false,
    timed_out: false,
  });
  mutable.bindWorkbenchSession = async () => ({
    ...workbenchSession,
    active_target_type: "command",
    active_target_id: "command-stateless-1",
    active_workspace_id: "ws-1",
  });
  mutable.appendWorkbenchSessionEvent = async () => {
    onAppendWorkbenchEvent?.();
    return {
      session_id: workbenchSession.session_id,
      sequence: 1,
      source: "plugin",
      actor: "chatgpt_plugin",
      event_type: "command.started",
      state: "RUNNING",
      target_type: "command",
      target_id: "command-stateless-1",
      workspace_id: "ws-1",
      tool_name: "cptr_code_run_command",
      summary: "ChatGPT started a CPTR workspace command.",
      details: {},
      metrics: {},
      policy: {},
      created_at: 1,
    };
  };
  return computer;
}

async function connectedServer(
  computer: ComputerClient,
  promptSessions: PromptTerminalStore,
  tickets: LiveTicketStore,
  toolSurface: "legacy" | "compact" = "legacy",
): Promise<{ client: Client; server: ReturnType<typeof createMcpServer> }> {
  const server = createMcpServer(computer, { promptSessions, tickets, toolSurface });
  const client = new Client({ name: "stateless-fixture", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

test("routes compact stateless workspace activity back to the opened Workbench", async () => {
  const promptSessions = new PromptTerminalStore({ streamingEnabled: true });
  const tickets = new LiveTicketStore();
  const computer = computerFixture();

  const first = await connectedServer(computer, promptSessions, tickets, "compact");
  const opened = await first.client.callTool({ name: "cptr_open_live_workbench", arguments: {} });
  const promptTicket = (opened._meta as { "cptr/prompt"?: { ticket?: string } } | undefined)?.["cptr/prompt"]?.ticket;
  const sessionId = (opened.structuredContent as { session_id?: string } | undefined)?.session_id;
  assert.ok(promptTicket);
  assert.ok(sessionId);
  await first.client.close();
  await first.server.close();

  const second = await connectedServer(computer, promptSessions, tickets, "compact");
  const listed = await second.client.callTool({
    name: "cptr_workspace",
    arguments: {
      action: "list",
      workbench_session_id: sessionId,
      payload: {},
    },
  });
  assert.equal(listed.isError, undefined);

  const replay = promptSessions.replay(promptTicket, 0);
  assert.ok(replay);
  const activity = replay.events.filter(
    (event) => event.type === "mcp.tool" && event.payload.tool_name === "cptr_workspace",
  );
  assert.deepEqual(
    activity.map((event) => event.type === "mcp.tool" ? event.payload.status : ""),
    ["STARTED", "COMPLETE"],
    "a compact stateless tool must keep publishing into the Workbench that supplied its routing ID",
  );

  await second.client.close();
  await second.server.close();
});


test("routes compact FDX activity without forwarding the Workbench routing hint to CPTR", async () => {
  const promptSessions = new PromptTerminalStore({ streamingEnabled: true });
  const tickets = new LiveTicketStore();
  const computer = computerFixture();
  let seenInput: Record<string, unknown> | null = null;
  (computer as any).runFdxIntelligence = async (input: Record<string, unknown>) => {
    seenInput = { ...input };
    return {
      workspace_id: "ws-1",
      action: "status",
      provider: "fdx_native",
      status: "ok",
      fallback_recommended: false,
      data: {},
    };
  };

  const first = await connectedServer(computer, promptSessions, tickets, "compact");
  const opened = await first.client.callTool({ name: "cptr_open_live_workbench", arguments: {} });
  const promptTicket = (opened._meta as { "cptr/prompt"?: { ticket?: string } } | undefined)?.["cptr/prompt"]?.ticket;
  const sessionId = (opened.structuredContent as { session_id?: string } | undefined)?.session_id;
  assert.ok(promptTicket);
  assert.ok(sessionId);
  await first.client.close();
  await first.server.close();

  const second = await connectedServer(computer, promptSessions, tickets, "compact");
  const status = await second.client.callTool({
    name: "cptr_fdx_intelligence",
    arguments: {
      workspace_id: "ws-1",
      action: "status",
      workbench_session_id: sessionId,
    },
  });
  assert.equal(status.isError, undefined);
  assert.ok(seenInput);
  assert.equal(
    (seenInput as Record<string, unknown>).workbench_session_id,
    undefined,
    "routing metadata must not leak into the backend FDX request",
  );

  const replay = promptSessions.replay(promptTicket, 0);
  assert.ok(replay);
  const activity = replay.events.filter(
    (event) => event.type === "mcp.tool" && event.payload.tool_name === "cptr_fdx_intelligence",
  );
  assert.deepEqual(
    activity.map((event) => event.type === "mcp.tool" ? event.payload.status : ""),
    ["STARTED", "COMPLETE"],
  );

  await second.client.close();
  await second.server.close();
});


test("routes compact command binding and later stateless status through nested payload identity", async () => {
  const promptSessions = new PromptTerminalStore({ streamingEnabled: true });
  const tickets = new LiveTicketStore();
  const computer = computerFixture();

  const first = await connectedServer(computer, promptSessions, tickets, "compact");
  const opened = await first.client.callTool({ name: "cptr_open_live_workbench", arguments: {} });
  const promptTicket = (opened._meta as { "cptr/prompt"?: { ticket?: string } } | undefined)?.["cptr/prompt"]?.ticket;
  const sessionId = (opened.structuredContent as { session_id?: string } | undefined)?.session_id;
  assert.ok(promptTicket);
  assert.ok(sessionId);
  await first.client.close();
  await first.server.close();

  const second = await connectedServer(computer, promptSessions, tickets, "compact");
  const command = await second.client.callTool({
    name: "cptr_command",
    arguments: {
      action: "run",
      payload: {
        workspace_id: "ws-1",
        command: "printf 'compact live line\\n'",
        workbench_session_id: sessionId,
      },
    },
  });
  assert.equal(command.isError, undefined);
  await second.client.close();
  await second.server.close();

  const afterRun = promptSessions.replay(promptTicket, 0);
  assert.ok(afterRun);
  const bind = afterRun.events.find((event) => event.type === "live.bind");
  assert.equal(bind?.type, "live.bind");
  if (bind?.type === "live.bind") {
    assert.equal(bind.payload.live.targetType, "command");
    assert.equal(bind.payload.live.targetId, "command-stateless-1");
    assert.equal(bind.payload.live.workspaceId, "ws-1");
  }

  const third = await connectedServer(computer, promptSessions, tickets, "compact");
  const followUp = await third.client.callTool({
    name: "cptr_command",
    arguments: {
      action: "status",
      payload: { workspace_id: "ws-1", command_id: "command-stateless-1" },
    },
  });
  assert.equal(followUp.isError, undefined);

  const replay = promptSessions.replay(promptTicket, 0);
  assert.ok(replay);
  const activity = replay.events.filter(
    (event) => event.type === "mcp.tool" && event.payload.tool_name === "cptr_command",
  );
  assert.deepEqual(
    activity.map((event) => event.type === "mcp.tool" ? event.payload.status : ""),
    ["STARTED", "COMPLETE", "STARTED", "COMPLETE"],
    "compact run and a later fresh-server status call must stay on the original Live Terminal",
  );

  await third.client.close();
  await third.server.close();
});


test("routes live command binding through the durable workbench session across MCP server recreation", async () => {
  const promptSessions = new PromptTerminalStore({ streamingEnabled: true });
  const tickets = new LiveTicketStore();
  let durableAppendCount = 0;
  const computer = computerFixture(() => { durableAppendCount += 1; });

  const first = await connectedServer(computer, promptSessions, tickets);
  const opened = await first.client.callTool({ name: "cptr_open_live_workbench", arguments: {} });
  const promptTicket = (opened._meta as { "cptr/prompt"?: { ticket?: string } } | undefined)?.["cptr/prompt"]?.ticket;
  const sessionId = (opened.structuredContent as { session_id?: string } | undefined)?.session_id;
  assert.ok(promptTicket);
  assert.equal(sessionId, workbenchSession.session_id);
  await first.client.close();
  await first.server.close();

  const second = await connectedServer(computer, promptSessions, tickets);
  const command = await second.client.callTool({
    name: "cptr_code_run_command",
    arguments: {
      workspace_id: "ws-1",
      command: "printf 'first live line\\n'",
      workbench_session_id: sessionId,
    },
  });
  assert.equal(command.isError, undefined);
  assert.equal(
    durableAppendCount,
    0,
    "command binding is already the durable RUNNING transition; a redundant plugin command.started append can arrive after fast completion",
  );

  const replay = promptSessions.replay(promptTicket, 0);
  assert.ok(replay);
  const bind = replay.events.find((event) => event.type === "live.bind");
  assert.equal(bind?.type, "live.bind", "stateless command call must reach the already-open prompt SSE stream");
  if (bind?.type === "live.bind") {
    assert.equal(bind.payload.live.targetType, "command");
    assert.equal(bind.payload.live.targetId, "command-stateless-1");
    assert.equal(bind.payload.live.workspaceId, "ws-1");
  }
  const commandActivity = replay.events.filter(
    (event) => event.type === "mcp.tool" && event.payload.tool_name === "cptr_code_run_command",
  );
  assert.deepEqual(
    commandActivity.map((event) => event.type === "mcp.tool" ? event.payload.status : ""),
    ["STARTED", "COMPLETE"],
    "stateless command lifecycle must remain visible in the prompt transcript",
  );

  await second.client.close();
  await second.server.close();
});


test("routes Direct Coding Worker commands into the existing prompt live terminal", async () => {
  const promptSessions = new PromptTerminalStore({ streamingEnabled: true });
  const tickets = new LiveTicketStore();
  const computer = computerFixture();

  const first = await connectedServer(computer, promptSessions, tickets);
  const opened = await first.client.callTool({ name: "cptr_open_live_workbench", arguments: {} });
  const promptTicket = (opened._meta as { "cptr/prompt"?: { ticket?: string } } | undefined)?.["cptr/prompt"]?.ticket;
  const sessionId = (opened.structuredContent as { session_id?: string } | undefined)?.session_id;
  assert.ok(promptTicket);
  assert.ok(sessionId);
  await first.client.close();
  await first.server.close();

  const second = await connectedServer(computer, promptSessions, tickets);
  const command = await second.client.callTool({
    name: "cptr_code_run_command",
    arguments: {
      workspace_id: "ws-1",
      worker_id: "dcw-live-terminal",
      command: "printf 'worker stdout\\n'; printf 'worker stderr\\n' >&2",
      workbench_session_id: sessionId,
    },
  });
  assert.equal(command.isError, undefined);

  const replay = promptSessions.replay(promptTicket, 0);
  assert.ok(replay);
  const workerActivity = replay.events.filter((event) => event.type === "direct.worker");
  const liveBind = replay.events.find((event) => event.type === "live.bind");
  assert.equal(liveBind?.type, "live.bind", "worker commands must bind the same Workbench to the real command SSE target");
  if (liveBind?.type === "live.bind") {
    assert.equal(liveBind.payload.live.targetType, "command");
    assert.equal(liveBind.payload.live.targetId, "command-stateless-1");
    assert.equal(liveBind.payload.live.workspaceId, "ws-1");
    assert.equal(liveBind.payload.live.workerId, "dcw-live-terminal");
  }
  assert.equal(workerActivity.length, 2, "compact worker metadata remains available around the live command binding");
  assert.ok(workerActivity[0]!.sequence < liveBind!.sequence, "worker start metadata must precede the command binding");
  assert.ok(liveBind!.sequence < workerActivity[1]!.sequence, "worker completion metadata may follow binding without clearing the command target");

  await second.client.close();
  await second.server.close();
});


test("routes stateless command follow-up activity back to the prompt that owns the live target", async () => {
  const promptSessions = new PromptTerminalStore({ streamingEnabled: true });
  const tickets = new LiveTicketStore();
  const computer = computerFixture();

  const first = await connectedServer(computer, promptSessions, tickets);
  const opened = await first.client.callTool({ name: "cptr_open_live_workbench", arguments: {} });
  const promptTicket = (opened._meta as { "cptr/prompt"?: { ticket?: string } } | undefined)?.["cptr/prompt"]?.ticket;
  const sessionId = (opened.structuredContent as { session_id?: string } | undefined)?.session_id;
  assert.ok(promptTicket);
  assert.ok(sessionId);
  await first.client.close();
  await first.server.close();

  const second = await connectedServer(computer, promptSessions, tickets);
  await second.client.callTool({
    name: "cptr_code_run_command",
    arguments: {
      workspace_id: "ws-1",
      command: "printf 'first live line\\n'",
      workbench_session_id: sessionId,
    },
  });
  await second.client.close();
  await second.server.close();

  const before = promptSessions.replay(promptTicket, 0);
  assert.ok(before);
  const beforeCount = before.events.filter(
    (event) => event.type === "mcp.tool" && event.payload.tool_name === "cptr_code_get_command",
  ).length;
  assert.equal(beforeCount, 0);

  const third = await connectedServer(computer, promptSessions, tickets);
  const followUp = await third.client.callTool({
    name: "cptr_code_get_command",
    arguments: { workspace_id: "ws-1", command_id: "command-stateless-1" },
  });
  assert.equal(followUp.isError, undefined);

  const replay = promptSessions.replay(promptTicket, 0);
  assert.ok(replay);
  const followUpActivity = replay.events.filter(
    (event) => event.type === "mcp.tool" && event.payload.tool_name === "cptr_code_get_command",
  );
  assert.deepEqual(
    followUpActivity.map((event) => event.type === "mcp.tool" ? event.payload.status : ""),
    ["STARTED", "COMPLETE"],
    "a resumed stateless command poll must remain visible on the original prompt SSE stream",
  );

  await third.client.close();
  await third.server.close();
});


test("reopening the same durable workbench keeps the original prompt SSE stream", async () => {
  const promptSessions = new PromptTerminalStore({ streamingEnabled: true });
  const tickets = new LiveTicketStore();
  const computer = computerFixture();

  const first = await connectedServer(computer, promptSessions, tickets);
  const opened = await first.client.callTool({
    name: "cptr_open_live_workbench",
    arguments: { delegation_authorization: "allow:delegate" },
  });
  const originalTicket = (opened._meta as { "cptr/prompt"?: { ticket?: string } } | undefined)?.["cptr/prompt"]?.ticket;
  const sessionId = (opened.structuredContent as { session_id?: string } | undefined)?.session_id;
  assert.ok(originalTicket);
  assert.ok(sessionId);
  assert.equal(promptSessions.allowsDelegation(originalTicket), true);
  await first.client.close();
  await first.server.close();

  const second = await connectedServer(computer, promptSessions, tickets);
  const resumed = await second.client.callTool({
    name: "cptr_open_live_workbench",
    arguments: { resume_session_id: sessionId },
  });
  const resumedTicket = (resumed._meta as { "cptr/prompt"?: { ticket?: string } } | undefined)?.["cptr/prompt"]?.ticket;
  assert.equal(resumedTicket, originalTicket, "a ChatGPT turn boundary must not strand the already-open Live Terminal");
  assert.equal(promptSessions.ticketForWorkbenchSession(sessionId), originalTicket);
  assert.equal(promptSessions.allowsDelegation(originalTicket), false, "delegation must require fresh authorization each user turn");

  await second.client.close();
  await second.server.close();
});
