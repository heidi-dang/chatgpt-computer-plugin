import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ComputerClient } from "../server/client/computer-client.js";
import { createMcpServer } from "../server/mcp.js";
import { PromptTerminalStore } from "../server/prompt-terminal.js";

test("routes the bounded second-layer workspace tools without accepting arbitrary test commands", async () => {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async (input, init) => {
      const url = String(input);
      seen.push({ url, init });
      const payload = String(url).endsWith("/workbench-sessions")
        ? {
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
          }
        : url.includes("/coding/test-targets")
          ? {
              target: "python_pytest",
              command_id: "command-1",
              status: "COMPLETE",
              exit_code: 0,
              output: "1 passed",
              next_offset: 8,
            }
          : { workspace_id: "ws-1", kind: JSON.parse(String(init?.body ?? "{}"))?.kind, safe: true };
      return new Response(JSON.stringify(payload), { status: 200 });
    },
  });
  const promptSessions = new PromptTerminalStore();
  const server = createMcpServer(computer, { promptSessions });
  const client = new Client({ name: "mcp-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const open = await client.callTool({ name: "cptr_open_live_workbench", arguments: {} });
  const promptTicket = (open._meta as { "cptr/prompt"?: { ticket?: string } } | undefined)?.["cptr/prompt"]?.ticket;
  assert.ok(promptTicket);

  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [
    { name: "cptr_workspace_detect_project", arguments: { workspace_id: "ws-1" } },
    { name: "cptr_workspace_tree", arguments: { workspace_id: "ws-1", depth: 2 } },
    { name: "cptr_workspace_file_metadata", arguments: { workspace_id: "ws-1", path: "package.json" } },
    { name: "cptr_workspace_read_many", arguments: { workspace_id: "ws-1", paths: ["package.json"] } },
    { name: "cptr_workspace_search_symbols", arguments: { workspace_id: "ws-1", query: "main" } },
    { name: "cptr_workspace_discover_tests", arguments: { workspace_id: "ws-1" } },
    { name: "cptr_workspace_dependency_summary", arguments: { workspace_id: "ws-1" } },
    { name: "cptr_workspace_package_scripts", arguments: { workspace_id: "ws-1" } },
    { name: "cptr_workspace_release_readiness", arguments: { workspace_id: "ws-1" } },
    { name: "cptr_workspace_run_test_target", arguments: { workspace_id: "ws-1", target: "python_pytest" } },
  ];

  for (const tool of calls) {
    const response = await client.callTool(tool);
    assert.equal(response.isError, undefined, `${tool.name} should complete without an MCP error`);
    assert.ok(response.structuredContent, `${tool.name} should return structured content`);
  }

  assert.equal(seen.filter(({ url }) => url.includes("/coding/inspect")).length, 9);
  const runner = seen.find(({ url }) => url.includes("/coding/test-targets"));
  assert.ok(runner);
  assert.deepEqual(JSON.parse(String(runner?.init?.body)), {
    target: "python_pytest",
    path: ".",
    wait_seconds: 0,
  });

  const run = await client.callTool({
    name: "cptr_workspace_run_test_target",
    arguments: { workspace_id: "ws-1", target: "python_pytest" },
  });
  assert.equal(run.isError, undefined);
  const replay = promptSessions.replay(promptTicket!, 0);
  const commandBinds = replay?.events.filter((event) => event.type === "live.bind") ?? [];
  const commandBind = commandBinds.at(-1);
  assert.equal(commandBind?.type, "live.bind");
  if (commandBind?.type === "live.bind") {
    assert.equal(commandBind.payload.live.targetType, "command");
    assert.equal(commandBind.payload.live.targetId, "command-1");
    assert.equal(commandBind.payload.live.workspaceId, "ws-1");
  }

  await client.close();
  await server.close();
});
