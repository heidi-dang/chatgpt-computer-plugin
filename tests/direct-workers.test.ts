import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ComputerClient } from "../server/client/computer-client.js";
import { createMcpServer } from "../server/mcp.js";
import {
  appendDirectWorkerActivity,
  initialWorkbenchState,
  type DirectWorkerActivity,
} from "../web/src/state.js";
import { DirectWorkersView } from "../web/src/direct-workers-view.js";


test("direct worker activity keeps worker state and mirrors concise progress into the single terminal", () => {
  const started: DirectWorkerActivity = {
    event_id: "worker-start",
    timestamp: "2026-08-28T00:00:00Z",
    type: "direct.worker",
    payload: {
      worker_id: "dcw_backend",
      name: "Backend",
      responsibility: "Backend stability",
      status: "RUNNING",
      summary: "Running backend tests",
      active_command_ids: ["cmd-1"],
      changed_file_count: 3,
    },
  };
  const completed: DirectWorkerActivity = {
    event_id: "worker-complete",
    timestamp: "2026-08-28T00:00:01Z",
    type: "direct.worker",
    payload: {
      worker_id: "dcw_backend",
      status: "COMPLETE",
      summary: "194 tests passed",
      active_command_ids: [],
      recent_command_ids: ["cmd-1"],
      changed_file_count: 3,
    },
  };

  const first = appendDirectWorkerActivity(initialWorkbenchState(), started);
  const second = appendDirectWorkerActivity(first, completed);

  assert.deepEqual(second.workerOrder, ["dcw_backend"]);
  assert.equal(second.workers.dcw_backend?.status, "COMPLETE");
  assert.equal(second.workers.dcw_backend?.summary, "194 tests passed");
  assert.equal(second.workers.dcw_backend?.changedFileCount, 3);
  assert.deepEqual(second.workers.dcw_backend?.recentCommandIds, ["cmd-1"]);
  assert.equal(second.transcript.length, 2);
  assert.equal(second.transcript[0]?.text, "[worker:Backend] Running backend tests");
  assert.equal(second.transcript[0]?.tone, "system");
  assert.equal(second.transcript[1]?.text, "[worker:Backend] 194 tests passed");
  assert.equal(second.transcript[1]?.tone, "success");
  assert.equal(second.workers.dcw_backend?.activity.length, 2);
});


test("worker dashboard renders lanes and Activity Changes Terminal tabs", () => {
  const state = appendDirectWorkerActivity(initialWorkbenchState(), {
    event_id: "worker-ui",
    timestamp: "2026-08-28T00:00:00Z",
    type: "direct.worker",
    payload: {
      worker_id: "dcw_backend",
      name: "Backend",
      responsibility: "Backend stability",
      status: "RUNNING",
      summary: "Running pytest",
      active_command_ids: ["cmd-1"],
      changed_file_count: 4,
    },
  });
  const html = renderToStaticMarkup(React.createElement(DirectWorkersView, {
    workers: state.workers,
    workerOrder: state.workerOrder,
    selectedWorkerId: "dcw_backend",
    selectedTab: "activity",
    connection: "prompt live",
    actionStatus: "",
    changesText: "4 files changed",
    terminalText: "",
    onSelectWorker: () => {},
    onSelectTab: () => {},
    onRefreshChanges: () => {},
    onRefreshTerminal: () => {},
    onPin: () => {},
    onExpand: () => {},
  }));

  assert.match(html, /Direct Coding Workers/);
  assert.match(html, /Backend/);
  assert.match(html, /Backend stability/);
  assert.match(html, /Running pytest/);
  assert.match(html, />Activity</);
  assert.match(html, />Changes</);
  assert.match(html, />Terminal</);
  assert.match(html, /1 active/);
});


test("MCP exposes model-free worker lifecycle and worker targeting on direct coding tools", async () => {
  const computer = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "test-token",
    fetchImpl: async () => new Response(JSON.stringify({}), { status: 200 }),
  });
  const server = createMcpServer(computer);
  const client = new Client({ name: "direct-worker-contract", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const listed = await client.listTools();
  const tools = new Map(listed.tools.map((tool) => [tool.name, tool]));
  for (const name of [
    "cptr_direct_worker_create",
    "cptr_direct_worker_list",
    "cptr_direct_worker_get",
    "cptr_direct_workers_overview",
    "cptr_direct_workers_integrate",
    "cptr_direct_worker_close",
  ]) {
    assert.ok(tools.has(name), `${name} must be registered`);
    assert.match(tools.get(name)?.title ?? "", /^\[ChatGPT Direct Coding\]/);
    assert.equal(tools.get(name)?.inputSchema.properties?.model_id, undefined);
  }

  for (const name of [
    "cptr_code_list_files",
    "cptr_code_read_file",
    "cptr_code_search_files",
    "cptr_code_write_file",
    "cptr_code_edit_file",
    "cptr_code_run_command",
    "cptr_code_get_command",
    "cptr_code_cancel_command",
    "cptr_code_get_git_status",
    "cptr_get_diff",
  ]) {
    assert.notEqual(tools.get(name)?.inputSchema.properties?.worker_id, undefined, `${name} must accept worker_id`);
  }

  await client.close();
  await server.close();
});
