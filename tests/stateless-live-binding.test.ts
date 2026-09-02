import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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

function computerFixture(): ComputerClient {
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async () => new Response(JSON.stringify({}), { status: 200 }),
  });
  const mutable = computer as unknown as {
    listWorkspaces: () => Promise<{ workspaces: unknown[] }>;
    createWorkbenchSession: () => Promise<typeof workbenchSession>;
    runCodingCommand: () => Promise<Record<string, unknown>>;
    bindWorkbenchSession: () => Promise<Record<string, unknown>>;
    appendWorkbenchSessionEvent: () => Promise<Record<string, unknown>>;
  };
  mutable.listWorkspaces = async () => ({ workspaces: [] });
  mutable.createWorkbenchSession = async () => ({ ...workbenchSession });
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
  mutable.bindWorkbenchSession = async () => ({
    ...workbenchSession,
    active_target_type: "command",
    active_target_id: "command-stateless-1",
    active_workspace_id: "ws-1",
  });
  mutable.appendWorkbenchSessionEvent = async () => ({
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
  });
  return computer;
}

async function connectedServer(
  computer: ComputerClient,
  promptSessions: PromptTerminalStore,
  tickets: LiveTicketStore,
): Promise<{ client: Client; server: ReturnType<typeof createMcpServer> }> {
  const server = createMcpServer(computer, { promptSessions, tickets });
  const client = new Client({ name: "stateless-fixture", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

test("routes live command binding through the durable workbench session across MCP server recreation", async () => {
  const promptSessions = new PromptTerminalStore({ streamingEnabled: true });
  const tickets = new LiveTicketStore();
  const computer = computerFixture();

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
