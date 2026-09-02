import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ComputerClient } from "../server/client/computer-client.js";
import { createMcpServer } from "../server/mcp.js";

function commandPayload() {
  return {
    command_id: "command-1",
    status: "RUNNING",
    exit_code: null,
    output: "",
    next_offset: 0,
    duration_ms: 1,
    output_truncated: false,
    timed_out: false,
    pty: true,
    rows: 40,
    cols: 132,
    recovered: false,
  };
}

test("exposes PTY command controls and workspace-scoped LSP lifecycle through MCP", async () => {
  const seen: Array<{ url: string; body: unknown }> = [];
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async (input, init) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      seen.push({ url, body });
      const payload = url.endsWith("/coding/lsp/discover")
        ? { workspace_id: "ws-1", servers: [{ server_id: "typescript", available: true, executable: "typescript-language-server" }] }
        : url.endsWith("/coding/lsp/start")
          ? { workspace_id: "ws-1", lsp_id: "lsp_123", server_id: "typescript", root: ".", status: "RUNNING", pid: 123, capabilities: {} }
          : url.endsWith("/coding/lsp/request")
            ? { workspace_id: "ws-1", lsp_id: "lsp_123", response: { jsonrpc: "2.0", id: 2, result: { contents: "hover" } } }
            : url.endsWith("/coding/lsp/stop")
              ? { workspace_id: "ws-1", lsp_id: "lsp_123", server_id: "typescript", status: "STOPPED" }
              : commandPayload();
      return new Response(JSON.stringify(payload), { status: 200 });
    },
  });
  const server = createMcpServer(computer);
  const client = new Client({ name: "terminal-parity-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  await client.callTool({
    name: "cptr_code_run_command",
    arguments: { workspace_id: "ws-1", command: "cat", pty: true, rows: 40, cols: 132, stdin: "hello\n" },
  });
  await client.callTool({ name: "cptr_code_send_input", arguments: { workspace_id: "ws-1", command_id: "command-1", data: "world\n" } });
  await client.callTool({ name: "cptr_code_resize_command", arguments: { workspace_id: "ws-1", command_id: "command-1", rows: 50, cols: 160 } });
  await client.callTool({ name: "cptr_code_signal_command", arguments: { workspace_id: "ws-1", command_id: "command-1", signal: "interrupt" } });
  await client.callTool({ name: "cptr_lsp_discover", arguments: { workspace_id: "ws-1" } });
  await client.callTool({ name: "cptr_lsp_start", arguments: { workspace_id: "ws-1", server_id: "typescript", root: "." } });
  await client.callTool({ name: "cptr_lsp_request", arguments: { workspace_id: "ws-1", lsp_id: "lsp_123", method: "textDocument/hover", params: { position: { line: 0, character: 0 } } } });
  await client.callTool({ name: "cptr_lsp_stop", arguments: { workspace_id: "ws-1", lsp_id: "lsp_123" } });

  assert.equal(seen.length, 8);
  assert.deepEqual(seen[0].body, {
    command: "cat", cwd: ".", wait_seconds: 0, allow_network: false,
    pty: true, rows: 40, cols: 132, stdin: "hello\n",
  });
  assert.deepEqual(seen[1].body, { data: "world\n" });
  assert.deepEqual(seen[2].body, { rows: 50, cols: 160 });
  assert.deepEqual(seen[3].body, { signal: "interrupt" });
  assert.deepEqual(seen[4].body, {});
  assert.deepEqual(seen[5].body, { server_id: "typescript", root: "." });
  assert.equal((seen[6].body as { method?: string }).method, "textDocument/hover");
  assert.deepEqual(seen[7].body, { lsp_id: "lsp_123" });

  await client.close();
  await server.close();
});
