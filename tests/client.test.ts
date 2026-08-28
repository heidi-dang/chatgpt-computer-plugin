import assert from "node:assert/strict";
import test from "node:test";
import { ComputerApiError, ComputerClient } from "../server/client/computer-client.js";

test("forwards the scoped token and returns JSON", async () => {
  let seenRequest: RequestInit | undefined;
  const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
    seenRequest = init;
    return new Response(JSON.stringify({ workspaces: [] }), { status: 200 });
  };
  const client = new ComputerClient({ baseUrl: "http://cptr.test/", token: "secret", fetchImpl });
  assert.deepEqual(await client.listWorkspaces(), { workspaces: [] });
  assert.equal((seenRequest?.headers as Record<string, string>).Authorization, "Bearer secret");
});

test("caches workspace discovery for 10 seconds and model discovery for 60 seconds", async () => {
  const calls: string[] = [];
  const client = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "secret-token",
    fetchImpl: async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({ models: [{ model_id: "provider/model", name: "model", default: true }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ workspaces: [{ workspace_id: "ws-1", name: "Workspace", available: true, last_used_at: 1 }] }), { status: 200 });
    },
  });

  await client.listWorkspaces(false);
  await client.listWorkspaces(false);
  await client.listWorkspaces(true);
  await client.listWorkspaces(true);
  await client.listModels();
  await client.listModels();

  assert.equal(calls.filter((url) => url.includes("/workspaces?")).length, 2);
  assert.equal(calls.filter((url) => url.endsWith("/models")).length, 1);
  assert.ok(calls.some((url) => url.endsWith("/workspaces?include_unavailable=false")));
  assert.ok(calls.some((url) => url.endsWith("/workspaces?include_unavailable=true")));
});

test("routes managed Chrome control through the existing scoped Control API", async () => {
  let seenUrl = "";
  let seenBody: Record<string, unknown> = {};
  const client = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "secret-token",
    fetchImpl: async (input, init) => {
      seenUrl = String(input);
      seenBody = JSON.parse(String(init?.body ?? "{}"));
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

  const response = await client.controlChromeBrowser({
    workspace_id: "ws-1",
    action: "status",
  });

  assert.equal(seenUrl, "http://cptr.test/api/control/v1/workspaces/ws-1/browser");
  assert.deepEqual(seenBody, { action: "status" });
  assert.equal(response.managed, true);
});

test("routes the single FDX intelligence gateway with repository and worker scope", async () => {
  let seenUrl = "";
  let seenBody: Record<string, unknown> = {};
  const client = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "secret-token",
    fetchImpl: async (input, init) => {
      seenUrl = String(input);
      seenBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({
        workspace_id: "ws-1",
        worker_id: "dcw-1",
        repo_path: "repo",
        action: "impact_v2",
        provider: "fdx_native",
        status: "ok",
        fallback_recommended: false,
        data: {},
      }), { status: 200 });
    },
  });

  await client.runFdxIntelligence({
    workspace_id: "ws-1",
    worker_id: "dcw-1",
    repo_path: "repo",
    action: "impact_v2",
    base: "HEAD",
    depth: 3,
  });

  assert.equal(seenUrl, "http://cptr.test/api/control/v1/workspaces/ws-1/coding/fdx");
  assert.deepEqual(seenBody, {
    worker_id: "dcw-1",
    repo_path: "repo",
    action: "impact_v2",
    base: "HEAD",
    depth: 3,
  });
});

test("normalizes CPTR errors without exposing credentials", async () => {
  const client = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "secret-token",
    fetchImpl: async () => new Response(JSON.stringify({ detail: "missing required scope: task:read" }), { status: 403 }),
  });
  await assert.rejects(client.getTask("task-1"), (error: unknown) => {
    assert.ok(error instanceof ComputerApiError);
    assert.equal(error.status, 403);
    assert.equal(error.message, "missing required scope: task:read");
    assert.equal(error.message.includes("secret-token"), false);
    return true;
  });
});

test("redacts Unix and Windows host paths from public API errors", async () => {
  const client = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "secret-token",
    fetchImpl: async () => new Response(
      JSON.stringify({ detail: "workspace /home/cptr/private/project missing; C:\\Users\\cptr\\secret is unavailable" }),
      { status: 409 },
    ),
  });

  await assert.rejects(client.getWorkspace("workspace-1"), (error: unknown) => {
    assert.ok(error instanceof ComputerApiError);
    assert.equal(error.status, 409);
    assert.equal(error.message.includes("/home/cptr/private/project"), false);
    assert.equal(error.message.includes("C:\\Users\\cptr\\secret"), false);
    assert.match(error.message, /<redacted-path>/);
    return true;
  });
});

test("converts request timeouts to a bounded public error", async () => {
  const client = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "secret-token",
    timeoutMs: 1,
    fetchImpl: (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }),
  });
  await assert.rejects(client.getTask("task-1"), (error: unknown) => {
    assert.ok(error instanceof ComputerApiError);
    assert.equal(error.status, 504);
    assert.equal(error.code, "computer_api_timeout");
    return true;
  });
});

test("routes dedicated autonomous operations to the scoped Control API", async () => {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const client = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "secret-token",
    fetchImpl: async (input, init) => {
      seen.push({ url: String(input), init });
      return new Response(JSON.stringify({ monitor_id: "mon-1", status: "RUNNING" }), { status: 200 });
    },
  });

  await client.createAutonomous({
    workspace_id: "ws-1",
    goal: "Repair the fixture",
    acceptance_criteria: ["tests pass"],
    model_id: "model-1",
    execution_policy: {
      allow_file_writes: true,
      allow_commands: true,
      allow_network: false,
      allow_package_install: false,
    },
  });
  await client.getAutonomous("mon-1");
  await client.getAutonomousEvents("mon-1");
  await client.getAutonomousEvidence("mon-1");
  await client.steerAutonomous("mon-1", "Continue", "steer-retry-1");
  await client.cancelAutonomous("mon-1");
  await client.approveAutonomous("mon-1", "approval-1", true);

  assert.deepEqual(seen.map((request) => request.url), [
    "http://cptr.test/api/control/v1/autonomous",
    "http://cptr.test/api/control/v1/autonomous/mon-1",
    "http://cptr.test/api/control/v1/autonomous/mon-1/events?after_sequence=0&max_events=100",
    "http://cptr.test/api/control/v1/autonomous/mon-1/evidence",
    "http://cptr.test/api/control/v1/autonomous/mon-1/messages",
    "http://cptr.test/api/control/v1/autonomous/mon-1/cancel",
    "http://cptr.test/api/control/v1/autonomous/mon-1/approve",
  ]);
  assert.equal((seen[3].init?.headers as Record<string, string>).Authorization, "Bearer secret-token");
  assert.deepEqual(JSON.parse(String(seen[0].init?.body)), {
    workspace_id: "ws-1",
    goal: "Repair the fixture",
    acceptance_criteria: ["tests pass"],
    model_id: "model-1",
    execution_policy: {
      allow_file_writes: true,
      allow_commands: true,
      allow_network: false,
      allow_package_install: false,
    },
  });
  assert.deepEqual(JSON.parse(String(seen[4].init?.body)), {
    content: "Continue",
    idempotency_key: "steer-retry-1",
  });
});

test("forwards task steering idempotency keys", async () => {
  let body = "";
  const client = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "secret-token",
    fetchImpl: async (_input, init) => {
      body = String(init?.body ?? "");
      return new Response(JSON.stringify({ task_id: "task-1", status: "QUEUED" }), { status: 200 });
    },
  });

  await client.sendMessage("task-1", "STEERING_MARKER_1", "task-retry-1");

  assert.deepEqual(JSON.parse(body), {
    content: "STEERING_MARKER_1",
    idempotency_key: "task-retry-1",
  });
});

test("executes an already-complete CPTR task without exposing raw agent events", async () => {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const client = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "secret-token",
    fetchImpl: async (input, init) => {
      seen.push({ url: String(input), init });
      return new Response(
        JSON.stringify({
          id: "task-1",
          workspace_id: "ws-1",
          chat_id: "chat-1",
          message_id: "message-1",
          status: "COMPLETE",
          prompt: "Inspect the fixture",
          model_id: "model-1",
          output: "Fixture inspected.",
          raw_output: [{ type: "internal-event" }],
          error: null,
        }),
        { status: 200 },
      );
    },
  });

  const result = await client.executeTask({
    workspace_id: "ws-1",
    prompt: "Inspect the fixture",
    model_id: "model-1",
    wait_seconds: 5,
    execution_policy: {
      allow_file_writes: false,
      allow_commands: true,
      allow_network: false,
      allow_package_install: false,
    },
  });

  assert.deepEqual(result, {
    task_id: "task-1",
    workspace_id: "ws-1",
    status: "COMPLETE",
    output: "Fixture inspected.",
    output_truncated: false,
    error: null,
    completed: true,
    wait_seconds: 5,
  });
  assert.deepEqual(seen.map((request) => request.url), ["http://cptr.test/api/control/v1/tasks"]);
  assert.equal((seen[0].init?.headers as Record<string, string>).Authorization, "Bearer secret-token");
  assert.deepEqual(JSON.parse(String(seen[0].init?.body)), {
    workspace_id: "ws-1",
    prompt: "Inspect the fixture",
    model_id: "model-1",
    execution_policy: {
      allow_file_writes: false,
      allow_commands: true,
      allow_network: false,
      allow_package_install: false,
    },
  });
});

test("fails closed when a completed task contains failed tool evidence", async () => {
  const taskPayload = {
    id: "task-1",
    workspace_id: "ws-1",
    chat_id: "chat-1",
    message_id: "message-1",
    status: "COMPLETE",
    prompt: "Inspect the fixture",
    model_id: "model-1",
    output: "CPTR_TASK_SELF_AUDIT_OK",
    raw_output: [
      { type: "function_call", call_id: "call-1", name: "list_directory", status: "completed" },
      {
        type: "function_call_output",
        call_id: "call-1",
        output: "Error: inspection scope violation: assignment scope has no allowed paths",
      },
      { type: "message", content: [{ type: "output_text", text: "CPTR_TASK_SELF_AUDIT_OK" }] },
    ],
    error: null,
  };
  const client = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "secret-token",
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith("/output")) {
        return new Response(
          JSON.stringify({
            task_id: taskPayload.id,
            status: taskPayload.status,
            content: taskPayload.output,
            raw_output: taskPayload.raw_output,
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify(taskPayload), { status: 200 });
    },
  });

  const direct = await client.executeTask({
    workspace_id: "ws-1",
    prompt: "Inspect the fixture",
    model_id: "model-1",
    wait_seconds: 1,
  });
  assert.equal(direct.status, "COMPLETE_WITH_TOOL_ERRORS");
  assert.equal(direct.completed, true);
  assert.deepEqual(direct.completion_integrity, { status: "TOOL_ERRORS", tool_error_count: 1 });

  const task = await client.getTask("task-1");
  assert.equal(task.status, "COMPLETE_WITH_TOOL_ERRORS");
  assert.deepEqual(task.completion_integrity, { status: "TOOL_ERRORS", tool_error_count: 1 });

  const output = await client.getTaskOutput("task-1");
  assert.equal(output.status, "COMPLETE_WITH_TOOL_ERRORS");
  assert.deepEqual(output.completion_integrity, { status: "TOOL_ERRORS", tool_error_count: 1 });
});

test("does not treat descriptive tool output as a failed call", async () => {
  const client = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "secret-token",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          id: "task-1",
          workspace_id: "ws-1",
          chat_id: "chat-1",
          message_id: "message-1",
          status: "COMPLETE",
          prompt: "Inspect error handling",
          model_id: "model-1",
          output: "Inspection complete.",
          raw_output: [
            {
              type: "function_call_output",
              call_id: "call-1",
              output: "Error handling is implemented.",
            },
          ],
          error: null,
        }),
        { status: 200 },
      ),
  });

  const task = await client.getTask("task-1");
  assert.equal(task.status, "COMPLETE");
  assert.equal(task.completion_integrity, undefined);
});

test("bounds direct-execution output before returning it to ChatGPT", async () => {
  const client = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "secret-token",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          id: "task-1",
          workspace_id: "ws-1",
          chat_id: "chat-1",
          message_id: "message-1",
          status: "COMPLETE",
          prompt: "Inspect the fixture",
          model_id: "model-1",
          output: "x".repeat(20_001),
          error: null,
        }),
        { status: 200 },
      ),
  });

  const result = await client.executeTask({
    workspace_id: "ws-1",
    prompt: "Inspect the fixture",
    model_id: "model-1",
  });

  assert.equal(result.output_truncated, true);
  assert.equal(result.output.endsWith("[Output truncated by the MCP adapter.]"), true);
  assert.equal(result.output.length, 20_040);
});


test("uses SSE first for a running direct task, then reads the terminal task state", async () => {
  let apiCalls = 0;
  let streamCalls = 0;
  const client = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "secret-token",
    fetchImpl: async (url) => {
      if (String(url).includes("/stream?")) {
        streamCalls += 1;
        return new Response(
          'data: {"event_type":"task.terminal","payload":{"status":"COMPLETE"}}\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      apiCalls += 1;
      const status = apiCalls === 1 ? "RUNNING" : "COMPLETE";
      return new Response(
        JSON.stringify({
          id: "task-1",
          workspace_id: "ws-1",
          chat_id: "chat-1",
          message_id: "message-1",
          status,
          prompt: "Inspect the fixture",
          model_id: "model-1",
          output: status === "COMPLETE" ? "Fixture inspected." : "",
          error: null,
        }),
        { status: 200 },
      );
    },
  });

  const result = await client.executeTask({
    workspace_id: "ws-1",
    prompt: "Inspect the fixture",
    model_id: "model-1",
    wait_seconds: 1,
  });

  assert.equal(apiCalls, 2);
  assert.equal(streamCalls, 1);
  assert.equal(result.completed, true);
  assert.equal(result.status, "COMPLETE");
});


test("routes direct ChatGPT coding operations only through scoped workspace endpoints", async () => {
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  const response = {
    workspace_id: "ws-1",
    path: "src/app.ts",
    command_id: "command-1",
    status: "COMPLETE",
    exit_code: 0,
    output: "ok",
    next_offset: 2,
    content: "export {};\n",
    start_line: 1,
    end_line: 1,
    total_lines: 1,
    size: 11,
    entries: "src/app.ts",
    matches: "src/app.ts:1:export {}",
    bytes_written: 11,
    replaced_characters: 1,
    inserted_characters: 1,
  };
  const client = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "secret-token",
    fetchImpl: async (input, init) => {
      seen.push({ url: String(input), init });
      return new Response(JSON.stringify(response), { status: 200 });
    },
  });

  await client.listCodingFiles({ workspace_id: "ws-1" });
  await client.readCodingFile({ workspace_id: "ws-1", path: "src/app.ts" });
  await client.searchCodingFiles({ workspace_id: "ws-1", query: "export" });
  await client.writeCodingFile({ workspace_id: "ws-1", path: "src/app.ts", content: "export {};\n" });
  await client.editCodingFile({
    workspace_id: "ws-1",
    path: "src/app.ts",
    target: "{}",
    replacement: "{ value: 1 }",
  });
  await client.runCodingCommand({ workspace_id: "ws-1", command: "npm test" });
  await client.getCodingCommand({ workspace_id: "ws-1", command_id: "command-1" });
  await client.cancelCodingCommand({ workspace_id: "ws-1", command_id: "command-1" });

  assert.deepEqual(seen.map((request) => request.url), [
    "http://cptr.test/api/control/v1/workspaces/ws-1/coding/list",
    "http://cptr.test/api/control/v1/workspaces/ws-1/coding/read",
    "http://cptr.test/api/control/v1/workspaces/ws-1/coding/search",
    "http://cptr.test/api/control/v1/workspaces/ws-1/coding/write",
    "http://cptr.test/api/control/v1/workspaces/ws-1/coding/edit",
    "http://cptr.test/api/control/v1/workspaces/ws-1/coding/commands",
    "http://cptr.test/api/control/v1/workspaces/ws-1/coding/commands/command-1?offset=0&wait_seconds=0",
    "http://cptr.test/api/control/v1/workspaces/ws-1/coding/commands/command-1/cancel",
  ]);
  const commandBody = JSON.parse(String(seen[5].init?.body));
  assert.equal(commandBody.model_id, undefined);
  assert.equal((seen[5].init?.headers as Record<string, string>).Authorization, "Bearer secret-token");
});

test("streams CPTR activity with server-side auth and a replay cursor", async () => {
  let seenUrl = "";
  let seenHeaders: Record<string, string> = {};
  const client = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "secret-token",
    fetchImpl: async (input, init) => {
      seenUrl = String(input);
      seenHeaders = init?.headers as Record<string, string>;
      return new Response("event: task.started\nid: 4\ndata: {}\n\n", { status: 200 });
    },
  });
  const response = await client.streamLive("task", "task-1", 3);
  assert.equal(response.ok, true);
  assert.equal(seenUrl, "http://cptr.test/api/control/v1/tasks/task-1/stream?after=3");
  assert.equal(seenHeaders.Authorization, "Bearer secret-token");
  assert.equal(seenHeaders.Accept, "text/event-stream");
  assert.equal(seenUrl.includes("secret-token"), false);
});

test("routes command live snapshot and stream through the workspace-owned control endpoints", async () => {
  const seen: string[] = [];
  const client = new ComputerClient({
    baseUrl: "http://cptr.test",
    token: "secret-token",
    fetchImpl: async (input) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ target: "command", snapshot: { status: "RUNNING" }, replay: { events: [] } }), { status: 200 });
    },
  });

  await client.getLiveSnapshot("command", "cmd-1", 7, "ws-1");
  await client.streamLive("command", "cmd-1", 8, "ws-1");

  assert.deepEqual(seen, [
    "http://cptr.test/api/control/v1/workspaces/ws-1/coding/commands/cmd-1/stream/snapshot?after=7",
    "http://cptr.test/api/control/v1/workspaces/ws-1/coding/commands/cmd-1/stream?after=8",
  ]);
});
