import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CLIENT_CAPABILITIES_META_KEY,
  isInputRequiredResult,
  type ServerContext,
} from "@modelcontextprotocol/server";
import type { ComputerClient } from "../server/client/computer-client.js";
import {
  NativeSubagentStateStore,
  type NewNativeSubagentState,
} from "../server/native-subagent-state.js";
import { NativeSubagentCoordinator } from "../server/native-subagents.js";

function context(
  requestState: unknown = undefined,
  inputResponses: Record<string, unknown> | undefined = undefined,
  signal: AbortSignal = new AbortController().signal,
  clientCapabilities: Record<string, unknown> = { sampling: { tools: {} } },
): ServerContext {
  return {
    sessionId: "test-session",
    mcpReq: {
      id: 1,
      method: "tools/call",
      envelope: {
        [CLIENT_CAPABILITIES_META_KEY]: clientCapabilities,
      },
      requestState: () => requestState,
      inputResponses,
      signal,
      log: async () => undefined,
      send: async () => ({} as never),
      notify: async () => undefined,
    },
    http: {
      authInfo: {
        token: "redacted-test-token",
        clientId: "test-client",
        scopes: ["mcp"],
      },
    },
  } as unknown as ServerContext;
}

function samplingText(text: string, stopReason = "endTurn") {
  return {
    model: "GPT-5.6 Sol",
    role: "assistant",
    stopReason,
    content: { type: "text", text },
  };
}

function samplingTools(tools: Array<{
  id: string;
  name: string;
  input: Record<string, unknown>;
}>) {
  return {
    model: "GPT-5.6 Sol",
    role: "assistant",
    stopReason: "toolUse",
    content: tools.map((tool) => ({
      type: "tool_use",
      id: tool.id,
      name: tool.name,
      input: tool.input,
    })),
  };
}

class FakeComputer {
  spawnCalls = 0;
  workerCreates: Array<Record<string, unknown>> = [];
  workerCloses: Array<Record<string, unknown>> = [];
  workerChanges = new Map<string, number>();
  failWorkerCreateAt: number | null = null;
  archives: string[] = [];
  codingCalls: Array<{ method: string; input: Record<string, unknown> }> = [];
  active = 0;
  peak = 0;
  activeByWorker = new Map<string, number>();
  peakByWorker = new Map<string, number>();

  async capabilityOs(action: string, payload: Record<string, unknown>) {
    if (action === "spawn_multiple_subagents") {
      this.spawnCalls += 1;
      const objectives = payload.objectives as string[];
      return {
        task: { taskId: "parent", workspaceId: "ws-1" },
        dispatch: {
          subagents: objectives.map((_, index) => ({
            task: { taskId: `child-${index + 1}` },
          })),
        },
      };
    }
    return { ok: true, action, task_id: payload.task_id };
  }

  async createDirectWorker(input: Record<string, unknown>) {
    const attempt = this.workerCreates.length + 1;
    if (this.failWorkerCreateAt === attempt) {
      throw new Error("simulated worker creation failure");
    }
    this.workerCreates.push(structuredClone(input));
    return {
      worker_id: `worker-${this.workerCreates.length}`,
      workspace_id: input.workspace_id,
    };
  }

  async getDirectWorker(input: Record<string, unknown>) {
    const workerId = String(input.worker_id ?? "");
    return {
      worker_id: workerId,
      workspace_id: String(input.workspace_id ?? ""),
      changed_file_count: this.workerChanges.get(workerId) ?? 0,
      integrated_at: null,
    };
  }

  async closeDirectWorker(input: Record<string, unknown>) {
    this.workerCloses.push(structuredClone(input));
    return { status: "CLOSED" };
  }

  async archiveWorkbenchSession(id: string) {
    this.archives.push(id);
    return { id, status: "ARCHIVED" };
  }

  private async coding(method: string, input: Record<string, unknown>) {
    this.codingCalls.push({ method, input: structuredClone(input) });
    const worker = String(input.worker_id ?? "");
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    const current = (this.activeByWorker.get(worker) ?? 0) + 1;
    this.activeByWorker.set(worker, current);
    this.peakByWorker.set(
      worker,
      Math.max(this.peakByWorker.get(worker) ?? 0, current),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    this.active -= 1;
    this.activeByWorker.set(worker, current - 1);
    return { ok: true, method };
  }

  async readCodingFile(input: Record<string, unknown>) {
    return this.coding("read", input);
  }
  async getGitStatus(input: Record<string, unknown>) {
    return this.coding("git_status", input);
  }
  async runCodingCommand(input: Record<string, unknown>) {
    return this.coding("run", input);
  }
  async listCodingFiles(input: Record<string, unknown>) { return this.coding("list", input); }
  async searchCodingFiles(input: Record<string, unknown>) { return this.coding("search", input); }
  async writeCodingFile(input: Record<string, unknown>) { return this.coding("write", input); }
  async editCodingFile(input: Record<string, unknown>) { return this.coding("edit", input); }
  async applyEdits(input: Record<string, unknown>) { return this.coding("apply_edits", input); }
  async createCodingDirectory(input: Record<string, unknown>) { return this.coding("mkdir", input); }
  async moveCodingFile(input: Record<string, unknown>) { return this.coding("move", input); }
  async deleteCodingFile(input: Record<string, unknown>) { return this.coding("delete", input); }
  async getDiff(input: Record<string, unknown>) { return this.coding("diff", input); }
  async getCodingCommand(input: Record<string, unknown>) { return this.coding("status", input); }
  async cancelCodingCommand(input: Record<string, unknown>) { return this.coding("cancel", input); }
  async runWorkspaceTestTarget(input: Record<string, unknown>) { return this.coding("run_test", input); }
  async runFdxIntelligence(input: Record<string, unknown>) { return this.coding("fdx", input); }
}

async function decodedRetryState(
  coordinator: NativeSubagentCoordinator,
  result: Record<string, unknown>,
) {
  assert.equal(isInputRequiredResult(result), true);
  const requestState = String(result.requestState);
  return coordinator.verifyRequestState(requestState, context());
}

test("native subagent state survives a store reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "cptr-native-subagents-"));
  const path = join(root, "state.sqlite");
  const initial: NewNativeSubagentState = {
    status: "running",
    parentTaskId: "parent",
    fingerprint: "fingerprint",
    idempotencyKey: "idempotent",
    objectives: ["one", "two"],
    maxTokens: 2048,
    requestedModel: "GPT-5.6 Sol",
    coding: false,
    workspaceId: null,
    repoPath: null,
    task: null,
    dispatch: null,
    branches: [],
    processingUntil: null,
    cleanup: null,
  };
  const first = new NativeSubagentStateStore(path);
  const created = first.begin(initial).state;
  first.close();

  const reopened = new NativeSubagentStateStore(path);
  const recovered = reopened.get(created.id);
  reopened.close();
  rmSync(root, { recursive: true, force: true });

  assert.equal(recovered?.id, created.id);
  assert.equal(recovered?.fingerprint, "fingerprint");
  assert.equal(recovered?.requestedModel, "GPT-5.6 Sol");
});

test("native fan-out rejects clients without sampling tools before allocating resources", async () => {
  const fake = new FakeComputer();
  const coordinator = new NativeSubagentCoordinator(
    fake as unknown as ComputerClient,
    { signingKey: Buffer.alloc(32, 5) },
  );

  await assert.rejects(
    coordinator.run(
      {
        task_id: "parent",
        tasks: ["audit auth", "audit runtime"],
        coding: true,
        workspace_id: "ws-1",
      },
      context(undefined, undefined, new AbortController().signal, { sampling: {} }),
      "GPT-5.6 Sol",
    ),
    /sampling\.tools/,
  );
  assert.equal(fake.spawnCalls, 0);
  assert.equal(fake.workerCreates.length, 0);
  coordinator.close();
});

test("native fan-out accepts legacy negotiated sampling tools when no per-request capability envelope exists", async () => {
  const fake = new FakeComputer();
  const coordinator = new NativeSubagentCoordinator(
    fake as unknown as ComputerClient,
    { signingKey: Buffer.alloc(32, 6) },
  );
  const legacyContext = context();
  delete (legacyContext.mcpReq as { envelope?: unknown }).envelope;

  const result = await coordinator.run(
    {
      task_id: "parent",
      tasks: ["audit auth", "audit runtime"],
    },
    legacyContext,
    "GPT-5.6 Sol",
    { sampling: { tools: {} } },
  );
  assert.equal(isInputRequiredResult(result), true);
  assert.equal(fake.spawnCalls, 1);
  coordinator.close();
});

test("native fan-out batches ChatGPT sampling, is idempotent, and rejects truncation as success", async () => {
  const fake = new FakeComputer();
  const coordinator = new NativeSubagentCoordinator(
    fake as unknown as ComputerClient,
    { signingKey: Buffer.alloc(32, 7) },
  );
  const payload = {
    task_id: "parent",
    tasks: ["audit auth", "audit runtime"],
    max_tokens: 1024,
    idempotency_key: "fanout-a",
  };

  const first = await coordinator.run(payload, context(), "GPT-5.6 Sol");
  assert.equal(isInputRequiredResult(first), true);
  const inputRequests = (first as { inputRequests: Record<string, any> }).inputRequests;
  assert.deepEqual(Object.keys(inputRequests), ["branch-1", "branch-2"]);
  assert.equal(inputRequests["branch-1"].method, "sampling/createMessage");
  assert.equal(inputRequests["branch-1"].params.tools.length, 6);
  assert.equal(
    inputRequests["branch-1"].params.modelPreferences.hints[0].name,
    "GPT-5.6 Sol",
  );
  assert.equal(fake.spawnCalls, 1);

  const state = await decodedRetryState(
    coordinator,
    first as unknown as Record<string, unknown>,
  );
  const final = await coordinator.run(
    payload,
    context(state, {
      "branch-1": samplingText("auth complete"),
      "branch-2": samplingText("runtime truncated", "maxTokens"),
    }),
    "GPT-5.6 Sol",
  ) as Record<string, any>;

  assert.equal(final.completed, 1);
  assert.equal(final.failed, 1);
  assert.equal(final.results[0].status, "complete");
  assert.equal(final.results[1].status, "incomplete");
  assert.match(final.results[1].error, /maxTokens/);
  assert.deepEqual(fake.archives.sort(), ["child-1", "child-2"]);

  const replay = await coordinator.run(payload, context(), "GPT-5.6 Sol") as Record<string, any>;
  assert.equal(replay.completed, 1);
  assert.equal(fake.spawnCalls, 1, "idempotent replay must not create another child cohort");
  coordinator.close();
});

test("coding fan-out isolates workers, runs branches concurrently, and preserves per-branch tool order", async () => {
  const fake = new FakeComputer();
  const coordinator = new NativeSubagentCoordinator(
    fake as unknown as ComputerClient,
    { signingKey: Buffer.alloc(32, 9) },
  );
  const payload = {
    task_id: "parent",
    tasks: ["inspect parser", "inspect API"],
    coding: true,
    workspace_id: "ws-1",
    repo_path: "repo",
    idempotency_key: "coding-fanout",
  };
  const first = await coordinator.run(payload, context(), "GPT-5.6 Sol");
  assert.equal(isInputRequiredResult(first), true);
  assert.equal(fake.workerCreates.length, 2);
  assert.deepEqual(
    fake.workerCreates.map((item) => item.idempotency_key),
    [
      (fake.workerCreates[0].idempotency_key as string),
      (fake.workerCreates[1].idempotency_key as string),
    ],
  );
  const inputRequests = (first as { inputRequests: Record<string, any> }).inputRequests;
  const names = inputRequests["branch-1"].params.tools.map((tool: any) => tool.name);
  assert.ok(names.includes("cptr_code"));
  assert.ok(names.includes("cptr_command"));
  assert.ok(names.includes("cptr_fdx_intelligence"));

  const firstState = await decodedRetryState(
    coordinator,
    first as unknown as Record<string, unknown>,
  );
  const second = await coordinator.run(
    payload,
    context(firstState, {
      "branch-1": samplingTools([
        {
          id: "a",
          name: "cptr_code",
          input: {
            action: "read",
            payload: { path: "src/a.ts", workspace_id: "escape", worker_id: "escape" },
          },
        },
        {
          id: "b",
          name: "cptr_code",
          input: { action: "git_status", payload: { workspace_id: "escape" } },
        },
      ]),
      "branch-2": samplingTools([
        {
          id: "c",
          name: "cptr_command",
          input: {
            action: "run",
            payload: {
              command: "npm test",
              allow_network: true,
              allow_package_install: true,
              root_prompt_approved: true,
              pty: true,
            },
          },
        },
      ]),
    }),
    "GPT-5.6 Sol",
  );
  assert.equal(isInputRequiredResult(second), true);
  assert.ok(fake.peak >= 2, "different ChatGPT branches should execute concurrently");
  assert.equal(fake.peakByWorker.get("worker-1"), 1, "one branch must preserve tool order");
  assert.equal(fake.peakByWorker.get("worker-2"), 1);

  const branch1Calls = fake.codingCalls.filter(
    (call) => call.input.worker_id === "worker-1",
  );
  assert.deepEqual(branch1Calls.map((call) => call.method), ["read", "git_status"]);
  for (const call of branch1Calls) {
    assert.equal(call.input.workspace_id, "ws-1");
    assert.equal(call.input.worker_id, "worker-1");
  }
  const command = fake.codingCalls.find((call) => call.method === "run");
  assert.equal(command?.input.workspace_id, "ws-1");
  assert.equal(command?.input.worker_id, "worker-2");
  assert.equal(command?.input.allow_network, false);
  assert.equal(command?.input.allow_package_install, false);
  assert.equal(command?.input.root_prompt_approved, false);
  assert.equal(command?.input.pty, false);

  const secondState = await decodedRetryState(
    coordinator,
    second as unknown as Record<string, unknown>,
  );
  const final = await coordinator.run(
    payload,
    context(secondState, {
      "branch-1": samplingText("parser done"),
      "branch-2": samplingText("API done"),
    }),
    "GPT-5.6 Sol",
  ) as Record<string, any>;
  assert.equal(final.completed, 2);
  assert.deepEqual(final.results.map((item: any) => item.worker_id), ["worker-1", "worker-2"]);
  assert.equal(final.dispatch.codingIsolation, "direct-coding-worker-per-branch");
  assert.equal(final.cleanup.workerClosed, 2);
  assert.equal(final.cleanup.workerPreserved, 0);
  assert.deepEqual(
    fake.workerCloses.map((item) => item.worker_id).sort(),
    ["worker-1", "worker-2"],
  );
  coordinator.close();
});

test("coding cleanup preserves dirty unintegrated workers for parent review", async () => {
  const fake = new FakeComputer();
  const coordinator = new NativeSubagentCoordinator(
    fake as unknown as ComputerClient,
    { signingKey: Buffer.alloc(32, 10) },
  );
  const payload = {
    task_id: "parent",
    tasks: ["change parser", "inspect API"],
    coding: true,
    workspace_id: "ws-1",
    idempotency_key: "dirty-preservation",
  };
  const first = await coordinator.run(payload, context(), "GPT-5.6 Sol");
  const firstState = await decodedRetryState(
    coordinator,
    first as unknown as Record<string, unknown>,
  );
  fake.workerChanges.set("worker-1", 2);
  const final = await coordinator.run(
    payload,
    context(firstState, {
      "branch-1": samplingText("parser changed"),
      "branch-2": samplingText("API inspected"),
    }),
    "GPT-5.6 Sol",
  ) as Record<string, any>;

  assert.equal(final.cleanup.workerAttempted, 2);
  assert.equal(final.cleanup.workerClosed, 1);
  assert.equal(final.cleanup.workerPreserved, 1);
  assert.deepEqual(fake.workerCloses.map((item) => item.worker_id), ["worker-2"]);
  coordinator.close();
});

test("partial coding initialization rolls back resources and permits a clean retry", async () => {
  const fake = new FakeComputer();
  const coordinator = new NativeSubagentCoordinator(
    fake as unknown as ComputerClient,
    { signingKey: Buffer.alloc(32, 12) },
  );
  const payload = {
    task_id: "parent",
    tasks: ["inspect parser", "inspect API"],
    coding: true,
    workspace_id: "ws-1",
    idempotency_key: "partial-init",
  };
  fake.failWorkerCreateAt = 2;
  await assert.rejects(
    coordinator.run(payload, context(), "GPT-5.6 Sol"),
    /simulated worker creation failure/,
  );
  assert.deepEqual(fake.archives.sort(), ["child-1", "child-2"]);
  assert.deepEqual(fake.workerCloses.map((item) => item.worker_id), ["worker-1"]);

  fake.failWorkerCreateAt = null;
  const retry = await coordinator.run(payload, context(), "GPT-5.6 Sol");
  assert.equal(isInputRequiredResult(retry), true);
  assert.equal(fake.spawnCalls, 2, "failed initialization must release its idempotent state");
  coordinator.close();
});

test("coding fan-out caps isolated worktrees at eight but reasoning supports ten", async () => {
  const fake = new FakeComputer();
  const coordinator = new NativeSubagentCoordinator(
    fake as unknown as ComputerClient,
    { signingKey: Buffer.alloc(32, 11) },
  );
  await assert.rejects(
    coordinator.run(
      { task_id: "parent", tasks: Array.from({ length: 9 }, (_, i) => `task-${i}`), coding: true },
      context(),
      "GPT-5.6 Sol",
    ),
    /at most 8/,
  );
  const reasoning = await coordinator.run(
    { task_id: "parent", tasks: Array.from({ length: 10 }, (_, i) => `task-${i}`) },
    context(),
    "GPT-5.6 Sol",
  );
  assert.equal(isInputRequiredResult(reasoning), true);
  assert.equal(
    Object.keys((reasoning as { inputRequests: Record<string, unknown> }).inputRequests).length,
    10,
  );
  coordinator.close();
});
