import { createHash, randomBytes } from "node:crypto";
import {
  CLIENT_CAPABILITIES_META_KEY,
  createRequestStateCodec,
  inputRequired,
  inputResponse,
  type InputRequiredResult,
  type ServerContext,
  type Tool,
} from "@modelcontextprotocol/server";
import type { ComputerClient } from "./client/computer-client.js";
import {
  NativeSubagentStateStore,
  type NativeSubagentBranch,
  type NativeSubagentState,
} from "./native-subagent-state.js";

const MAX_BRANCHES = 10;
const MAX_CODING_BRANCHES = 8;
const MAX_OBJECTIVE_CHARS = 20_000;
const MAX_TOKENS = 4_096;
const MAX_SAMPLING_ROUNDS = 6;
const MAX_TOOL_CALLS_PER_BRANCH = 16;
const MAX_TOOL_INPUT_CHARS = 50_000;
const MAX_TOOL_RESULT_CHARS = 12_000;
const DEFAULT_TTL_MS = 30 * 60_000;

type StateRef = {
  kind: "cptr-native-subagents-v1";
  fanoutId: string;
  fingerprint: string;
};

type NormalizedSpawn = {
  parentTaskId: string;
  objectives: string[];
  maxTokens: number;
  idempotencyKey: string | null;
  requestedModel: string | null;
  coding: boolean;
  workspaceId: string | null;
  repoPath: string | null;
  fingerprint: string;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function jsonSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function stringifyBounded(value: unknown): {
  text: string;
  structured: unknown;
} {
  const serialized = JSON.stringify(value ?? null);
  if (serialized.length <= MAX_TOOL_RESULT_CHARS) {
    return { text: serialized, structured: value ?? null };
  }
  const text = serialized.slice(0, MAX_TOOL_RESULT_CHARS);
  return { text, structured: { truncated: true, text } };
}

function samplingText(content: unknown): string {
  const blocks = Array.isArray(content) ? content : [content];
  return blocks
    .map((block) => {
      const item = record(block);
      return item.type === "text" && typeof item.text === "string" ? item.text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function samplingToolUses(content: unknown): Array<{
  id: string;
  name: string;
  input: Record<string, unknown>;
}> {
  const blocks = Array.isArray(content) ? content : [content];
  const uses: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
  for (const block of blocks) {
    const item = record(block);
    if (item.type !== "tool_use") continue;
    const id = typeof item.id === "string" ? item.id : "";
    const name = typeof item.name === "string" ? item.name : "";
    if (id && name) uses.push({ id, name, input: record(item.input) });
  }
  return uses;
}

function branchPrompt(
  index: number,
  total: number,
  objective: string,
  childTaskId: string,
  workspaceId: string | null,
  workerId: string | null,
): string {
  const codingContext = workspaceId && workerId
    ? [
        `CODING WORKSPACE: ${workspaceId}`,
        `ISOLATED DIRECT CODING WORKER: ${workerId}`,
        "All cptr_code and cptr_command operations are server-bound to that worker. Do not attempt to target another workspace or worker.",
        "Do not commit, push, merge, deploy, release, or discard the worker. Leave changes for the mother ChatGPT to review and integrate.",
      ].join("\n")
    : "No Direct Coding Worker is attached. Treat this as an analysis/Capability-OS continuation.";
  return [
    "You are a native isolated parallel continuation of the calling ChatGPT model.",
    "Work only on the assigned objective. Do not create or call CPTR delegated agents, Hermes, Codex workers, or external model workers.",
    "You already own an isolated Capability OS child task. Use only the bound tools supplied in this sampling request.",
    codingContext,
    "Do not claim work you did not verify. Keep changes scoped to your objective and return a compact result with status, findings, evidence, changes, blockers, and next action.",
    `CHILD TASK: ${childTaskId}`,
    `BRANCH ${index + 1}/${total} OBJECTIVE:`,
    objective,
  ].join("\n\n");
}

const SUBAGENT_TOOLS: Tool[] = [
  {
    name: "cptr_inspect",
    description: "Inspect this isolated Capability OS child task.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
      additionalProperties: false,
    },
  },
  {
    name: "cptr_resolve",
    description: "Resolve task-visible capabilities for required effects.",
    inputSchema: {
      type: "object",
      properties: {
        required: { type: "array", items: { type: "object" } },
        optional: { type: "array", items: { type: "object" } },
        forbidden: { type: "array", items: { type: "object" } },
      },
      required: ["required"],
      additionalProperties: false,
    },
  },
  {
    name: "cptr_forge",
    description: "Forge or evolve a tool inside this isolated Capability OS child task.",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", minLength: 1 },
        payload: { type: "object" },
      },
      required: ["operation"],
      additionalProperties: false,
    },
  },
  {
    name: "cptr_execute",
    description: "Execute a task-visible Capability inside this isolated child task.",
    inputSchema: {
      type: "object",
      properties: {
        capability_digest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
        lease_id: { type: "string" },
        inputs: { type: "object" },
        approval_id: { type: "string" },
      },
      required: ["capability_digest"],
      additionalProperties: false,
    },
  },
  {
    name: "cptr_acquire",
    description: "Discover, qualify, mount, invoke, or release MCP capabilities for this child task.",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", minLength: 1 },
        payload: { type: "object" },
      },
      required: ["operation"],
      additionalProperties: false,
    },
  },
  {
    name: "cptr_reflect",
    description: "Record evidence for this isolated Capability OS child task.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", minLength: 1 },
        claims: { type: "object" },
        artifact_digest: { type: "string" },
        lease_id: { type: "string" },
        comparison: { type: "object" },
        experiment: { type: "object" },
        change_class: { type: "string" },
        promotion_target_state: { type: "string" },
        owner_approval_id: { type: "string" },
      },
      required: ["kind", "claims"],
      additionalProperties: false,
    },
  },
];

const CODING_TOOLS: Tool[] = [
  {
    name: "cptr_code",
    description: "Operate only on this branch's isolated Direct Coding Worker.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "read", "search", "write", "edit", "apply_edits", "mkdir", "move", "delete", "git_status", "diff"],
        },
        payload: { type: "object" },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "cptr_command",
    description: "Run or inspect commands only inside this branch's isolated worker. Network, package installation, and root escalation are disabled.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["run", "status", "cancel", "run_test"] },
        payload: { type: "object" },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "cptr_fdx_intelligence",
    description: "Use CPTR repository intelligence against this branch's isolated worker.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", minLength: 1 },
        payload: { type: "object" },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
];

export class NativeSubagentCoordinator {
  private readonly client: ComputerClient;
  private readonly store: NativeSubagentStateStore;
  private readonly stateCodec;

  constructor(
    client: ComputerClient,
    options: {
      stateDbPath?: string;
      signingKey?: string | Uint8Array;
      ttlMs?: number;
    } = {},
  ) {
    this.client = client;
    this.store = new NativeSubagentStateStore(
      options.stateDbPath ?? ":memory:",
      { ttlMs: options.ttlMs },
    );
    this.stateCodec = createRequestStateCodec<StateRef>({
      key: options.signingKey ?? randomBytes(32),
      ttlSeconds: Math.max(
        60,
        Math.floor((options.ttlMs ?? DEFAULT_TTL_MS) / 1000),
      ),
      bind: (ctx) =>
        `${ctx.mcpReq.method}\0${ctx.http?.authInfo?.clientId ?? "anonymous"}`,
    });
  }

  close(): void {
    this.store.close();
  }

  readonly verifyRequestState = (state: string, ctx: ServerContext) =>
    this.stateCodec.verify(state, ctx);

  private assertSamplingToolsCapability(
    ctx: ServerContext,
    negotiatedCapabilities?: Record<string, unknown>,
  ): void {
    const envelope = record(ctx.mcpReq.envelope);
    const hasPerRequestCapabilities = Object.prototype.hasOwnProperty.call(
      envelope,
      CLIENT_CAPABILITIES_META_KEY,
    );
    const capabilities = hasPerRequestCapabilities
      ? record(envelope[CLIENT_CAPABILITIES_META_KEY])
      : record(negotiatedCapabilities);
    const sampling = record(capabilities.sampling);
    if (!("sampling" in capabilities) || !("tools" in sampling)) {
      throw new Error(
        "native ChatGPT subagent fan-out requires the MCP client capability sampling.tools before resources can be allocated",
      );
    }
  }

  private normalize(
    payload: Record<string, unknown>,
    requestedModel: string | null,
  ): NormalizedSpawn {
    const parentTaskId =
      typeof payload.task_id === "string" ? payload.task_id.trim() : "";
    if (!parentTaskId) {
      throw new Error("task_id is required for spawn_multiple_subagents");
    }
    if (
      !Array.isArray(payload.tasks)
      || payload.tasks.length < 2
      || payload.tasks.length > MAX_BRANCHES
    ) {
      throw new Error("tasks must contain between 2 and 10 objectives");
    }
    const objectives = payload.tasks.map((value) => String(value ?? "").trim());
    if (objectives.some((value) => !value)) {
      throw new Error("tasks must not contain blank objectives");
    }
    if (objectives.some((value) => value.length > MAX_OBJECTIVE_CHARS)) {
      throw new Error(
        `each task objective must be at most ${MAX_OBJECTIVE_CHARS} characters`,
      );
    }
    const rawMaxTokens =
      payload.max_tokens == null ? 2_048 : Number(payload.max_tokens);
    if (
      !Number.isSafeInteger(rawMaxTokens)
      || rawMaxTokens < 128
      || rawMaxTokens > MAX_TOKENS
    ) {
      throw new Error(
        `max_tokens must be an integer between 128 and ${MAX_TOKENS}`,
      );
    }
    const idempotencyKey =
      typeof payload.idempotency_key === "string" && payload.idempotency_key.trim()
        ? payload.idempotency_key.trim().slice(0, 200)
        : null;
    const coding = payload.coding === true;
    if (coding && objectives.length > MAX_CODING_BRANCHES) {
      throw new Error(
        `coding fan-out supports at most ${MAX_CODING_BRANCHES} isolated workers per workspace`,
      );
    }
    const workspaceId =
      typeof payload.workspace_id === "string" && payload.workspace_id.trim()
        ? payload.workspace_id.trim()
        : null;
    const repoPath =
      typeof payload.repo_path === "string" && payload.repo_path.trim()
        ? payload.repo_path.trim()
        : coding ? "." : null;
    const fingerprint = sha256(JSON.stringify({
      parentTaskId,
      objectives,
      maxTokens: rawMaxTokens,
      idempotencyKey,
      requestedModel,
      coding,
      workspaceId,
      repoPath,
    }));
    return {
      parentTaskId,
      objectives,
      maxTokens: rawMaxTokens,
      idempotencyKey,
      requestedModel,
      coding,
      workspaceId,
      repoPath,
      fingerprint,
    };
  }

  private finalResult(state: NativeSubagentState): Record<string, unknown> {
    const results = state.branches.map((branch) => ({
      index: branch.index,
      task_id: branch.taskId,
      workspace_id: branch.workspaceId,
      worker_id: branch.workerId,
      objective: branch.objective,
      status: branch.status,
      output: branch.output,
      model: branch.model,
      rounds: branch.rounds,
      tool_calls: branch.toolCalls,
      ...(branch.error ? { error: branch.error } : {}),
    }));
    const completed = results.filter((item) => item.status === "complete").length;
    return {
      task: state.task,
      requested: results.length,
      completed,
      failed: results.length - completed,
      dispatch: {
        ...(state.dispatch ?? {}),
        mode: "native-chatgpt-client-sampling",
        protocol: "MCP 2026 multi-round input_required sampling",
        samplingRequestsBatchedInSingleRound: true,
        clientParallelSchedulingRequired: true,
        hostParallelInferenceVerified: false,
        requestedModel: state.requestedModel,
        modelSelection: "client-controlled",
        coding: state.coding,
        workspaceId: state.workspaceId,
        repoPath: state.repoPath,
        fallback: "none",
      },
      cleanup: state.cleanup,
      results,
    };
  }

  private async cleanupChildren(
    state: NativeSubagentState,
  ): Promise<NativeSubagentState> {
    const ids = state.branches.map((branch) => branch.taskId).filter(Boolean);
    const workers = state.branches.filter(
      (branch) => branch.workspaceId && branch.workerId,
    );
    const [settled, workerOutcomes] = await Promise.all([
      Promise.allSettled(
        ids.map((id) => this.client.archiveWorkbenchSession(id)),
      ),
      Promise.all(
        workers.map(async (branch) => {
          try {
            const worker = await this.client.getDirectWorker({
              workspace_id: branch.workspaceId!,
              worker_id: branch.workerId!,
            });
            if (worker.changed_file_count > 0 && worker.integrated_at == null) {
              return "preserved" as const;
            }
            await this.client.closeDirectWorker({
              workspace_id: branch.workspaceId!,
              worker_id: branch.workerId!,
              discard_changes: false,
            });
            return "closed" as const;
          } catch {
            return "failed" as const;
          }
        }),
      ),
    ]);
    const released = settled.filter((item) => item.status === "fulfilled").length;
    return {
      ...state,
      cleanup: {
        attempted: ids.length,
        released,
        failed: ids.length - released,
        workerAttempted: workers.length,
        workerClosed: workerOutcomes.filter((item) => item === "closed").length,
        workerPreserved: workerOutcomes.filter((item) => item === "preserved").length,
        workerFailed: workerOutcomes.filter((item) => item === "failed").length,
      },
    };
  }

  private async executeTool(
    branch: NativeSubagentBranch,
    toolUse: { id: string; name: string; input: Record<string, unknown> },
  ): Promise<unknown> {
    if (jsonSize(toolUse.input) > MAX_TOOL_INPUT_CHARS) {
      return { error: "sampling tool input exceeds the bounded size limit" };
    }
    if (
      toolUse.name === "cptr_forge"
      && String(toolUse.input.operation ?? "").trim().toLowerCase() === "bootstrap"
    ) {
      return {
        error:
          "native subagents already have an isolated Capability OS child task",
      };
    }
    switch (toolUse.name) {
      case "cptr_inspect":
        return this.client.capabilityOs("inspect", {
          ...toolUse.input,
          task_id: branch.taskId,
        });
      case "cptr_resolve":
      case "cptr_forge":
      case "cptr_execute":
      case "cptr_acquire":
      case "cptr_reflect":
        return this.client.capabilityOs(
          toolUse.name.slice("cptr_".length) as
            | "resolve"
            | "forge"
            | "execute"
            | "acquire"
            | "reflect",
          { ...toolUse.input, task_id: branch.taskId },
        );
      case "cptr_code": {
        if (!branch.workspaceId || !branch.workerId) {
          return { error: "this native subagent has no Direct Coding Worker" };
        }
        const action = String(toolUse.input.action ?? "").trim();
        const payload = {
          ...record(toolUse.input.payload),
          workspace_id: branch.workspaceId,
          worker_id: branch.workerId,
        };
        switch (action) {
          case "list": return this.client.listCodingFiles(payload as never);
          case "read": return this.client.readCodingFile(payload as never);
          case "search": return this.client.searchCodingFiles(payload as never);
          case "write": return this.client.writeCodingFile(payload as never);
          case "edit": return this.client.editCodingFile(payload as never);
          case "apply_edits": return this.client.applyEdits(payload as never);
          case "mkdir": return this.client.createCodingDirectory(payload as never);
          case "move": return this.client.moveCodingFile(payload as never);
          case "delete": return this.client.deleteCodingFile(payload as never);
          case "git_status": return this.client.getGitStatus(payload as never);
          case "diff": return this.client.getDiff(payload as never);
          default: return { error: `unsupported native cptr_code action: ${action}` };
        }
      }
      case "cptr_command": {
        if (!branch.workspaceId || !branch.workerId) {
          return { error: "this native subagent has no Direct Coding Worker" };
        }
        const action = String(toolUse.input.action ?? "").trim();
        const raw = record(toolUse.input.payload);
        const waitSeconds = Math.max(
          0,
          Math.min(20, Number.isFinite(Number(raw.wait_seconds)) ? Number(raw.wait_seconds) : 0),
        );
        const payload = {
          ...raw,
          workspace_id: branch.workspaceId,
          worker_id: branch.workerId,
          wait_seconds: waitSeconds,
        };
        switch (action) {
          case "run":
            return this.client.runCodingCommand({
              ...payload,
              allow_network: false,
              allow_package_install: false,
              root_prompt_approved: false,
              pty: false,
            } as never);
          case "status": return this.client.getCodingCommand(payload as never);
          case "cancel": return this.client.cancelCodingCommand(payload as never);
          case "run_test": return this.client.runWorkspaceTestTarget(payload as never);
          default: return { error: `unsupported native cptr_command action: ${action}` };
        }
      }
      case "cptr_fdx_intelligence": {
        if (!branch.workspaceId || !branch.workerId) {
          return { error: "this native subagent has no Direct Coding Worker" };
        }
        const action = String(toolUse.input.action ?? "").trim();
        return this.client.runFdxIntelligence({
          ...record(toolUse.input.payload),
          workspace_id: branch.workspaceId,
          worker_id: branch.workerId,
          action,
        });
      }
      default:
        return { error: `unknown native subagent tool: ${toolUse.name}` };
    }
  }


  private samplingRequest(
    branch: NativeSubagentBranch,
    state: NativeSubagentState,
  ) {
    return inputRequired.createMessage({
      messages: branch.messages as never,
      maxTokens: state.maxTokens,
      ...(state.requestedModel
        ? { modelPreferences: { hints: [{ name: state.requestedModel }] } }
        : {}),
      tools: branch.workerId
        ? [...SUBAGENT_TOOLS, ...CODING_TOOLS]
        : SUBAGENT_TOOLS,
      toolChoice: { mode: "auto" },
    });
  }

  private async inputRequiredResult(
    state: NativeSubagentState,
    ctx: ServerContext,
  ): Promise<InputRequiredResult> {
    const requestState = await this.stateCodec.mint(
      {
        kind: "cptr-native-subagents-v1",
        fanoutId: state.id,
        fingerprint: state.fingerprint,
      },
      ctx,
    );
    const inputRequests = Object.fromEntries(
      state.branches
        .filter((branch) => branch.status === "pending")
        .map((branch) => [branch.key, this.samplingRequest(branch, state)]),
    );
    return inputRequired({
      ...(Object.keys(inputRequests).length ? { inputRequests } : {}),
      requestState,
    });
  }

  private async initialize(
    state: NativeSubagentState,
  ): Promise<NativeSubagentState> {
    if (state.branches.length) return state;
    const prepared = await this.client.capabilityOs("spawn_multiple_subagents", {
      task_id: state.parentTaskId,
      objectives: state.objectives,
      cohort_id: state.id,
    });
    const dispatch = record(prepared.dispatch);
    const children = Array.isArray(dispatch.subagents) ? dispatch.subagents : [];
    if (children.length !== state.objectives.length) {
      throw new Error("CPTR backend returned an invalid native subagent cohort");
    }
    const childIds = children.map((value) => {
      const task = record(record(value).task);
      return typeof task.taskId === "string" ? task.taskId.trim() : "";
    });
    if (
      childIds.some((id) => !id)
      || new Set(childIds).size !== childIds.length
    ) {
      throw new Error(
        "CPTR backend returned invalid or duplicate native subagent task IDs",
      );
    }

    const parentTask = record(prepared.task);
    const parentWorkspaceId =
      typeof parentTask.workspaceId === "string" && parentTask.workspaceId.trim()
        ? parentTask.workspaceId.trim()
        : null;
    if (
      state.workspaceId
      && parentWorkspaceId
      && state.workspaceId !== parentWorkspaceId
    ) {
      await Promise.allSettled(
        childIds.map((id) => this.client.archiveWorkbenchSession(id)),
      );
      throw new Error(
        "coding fan-out workspace_id must match the parent Workbench workspace",
      );
    }
    const workspaceId = state.workspaceId ?? parentWorkspaceId;
    if (state.coding && !workspaceId) {
      await Promise.allSettled(
        childIds.map((id) => this.client.archiveWorkbenchSession(id)),
      );
      throw new Error(
        "coding fan-out requires a workspace-bound parent task or explicit workspace_id",
      );
    }

    const workerIds: Array<string | null> = state.objectives.map(() => null);
    try {
      if (state.coding && workspaceId) {
        for (let index = 0; index < state.objectives.length; index += 1) {
          const worker = await this.client.createDirectWorker({
            workspace_id: workspaceId,
            name: `Native ChatGPT Subagent ${String(index + 1).padStart(2, "0")}`,
            responsibility: state.objectives[index].slice(0, 500),
            repo_path: state.repoPath ?? ".",
            idempotency_key: `${state.id}:branch-${index + 1}`,
          });
          workerIds[index] = worker.worker_id;
        }
      }
    } catch (error) {
      await Promise.allSettled(
        workerIds.flatMap((workerId) =>
          workerId && workspaceId
            ? [this.client.closeDirectWorker({
                workspace_id: workspaceId,
                worker_id: workerId,
                discard_changes: false,
              })]
            : [],
        ),
      );
      await Promise.allSettled(
        childIds.map((id) => this.client.archiveWorkbenchSession(id)),
      );
      throw error;
    }

    return {
      ...state,
      status: "running",
      workspaceId,
      task: prepared.task ?? null,
      dispatch: {
        ...dispatch,
        codingIsolation: state.coding
          ? "direct-coding-worker-per-branch"
          : "capability-os-task-only",
      },
      branches: state.objectives.map(
        (objective, index): NativeSubagentBranch => ({
          key: `branch-${index + 1}`,
          index,
          taskId: childIds[index],
          workspaceId: state.coding ? workspaceId : null,
          workerId: workerIds[index],
          objective,
          status: "pending",
          rounds: 0,
          toolCalls: 0,
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: branchPrompt(
                  index,
                  state.objectives.length,
                  objective,
                  childIds[index],
                  state.coding ? workspaceId : null,
                  workerIds[index],
                ),
              },
            },
          ],
          output: "",
          error: "",
          model: null,
        }),
      ),
      processingUntil: null,
    };
  }

  private async processBranch(
    branch: NativeSubagentBranch,
    responses: Record<string, unknown> | undefined,
    signal: AbortSignal,
  ): Promise<NativeSubagentBranch> {
    if (branch.status !== "pending") return branch;
    if (signal.aborted) {
      return {
        ...branch,
        status: "cancelled",
        error: "calling ChatGPT cancelled the fan-out",
      };
    }

    const view = inputResponse(responses, branch.key);
    if (view.kind !== "sampling") {
      return {
        ...branch,
        status: "client_sampling_failed",
        error: "client did not return a sampling result for this branch",
      };
    }

    const response = view.result;
    const next: NativeSubagentBranch = {
      ...branch,
      model: typeof response.model === "string" ? response.model : null,
      messages: [
        ...branch.messages,
        { role: "assistant", content: response.content },
      ],
    };
    const toolUses = samplingToolUses(response.content);
    if (!toolUses.length) {
      if (response.stopReason === "maxTokens") {
        return {
          ...next,
          status: "incomplete",
          output: samplingText(response.content),
          error: "client sampling stopped at maxTokens before the branch completed",
        };
      }
      return {
        ...next,
        status: "complete",
        output: samplingText(response.content),
      };
    }

    const rounds = branch.rounds + 1;
    const toolCalls = branch.toolCalls + toolUses.length;
    if (rounds > MAX_SAMPLING_ROUNDS) {
      return {
        ...next,
        rounds,
        status: "limit_exceeded",
        error: "sampling round limit exceeded",
      };
    }
    if (toolCalls > MAX_TOOL_CALLS_PER_BRANCH) {
      return {
        ...next,
        rounds,
        toolCalls,
        status: "limit_exceeded",
        error: "native subagent tool-call budget exceeded",
      };
    }

    const toolResults: unknown[] = [];
    // Preserve tool-use order inside one logical subagent. Different branches
    // are processed concurrently by the caller.
    for (const toolUse of toolUses) {
      if (signal.aborted) {
        return {
          ...next,
          rounds,
          toolCalls,
          status: "cancelled",
          error: "calling ChatGPT cancelled the fan-out",
        };
      }
      let value: unknown;
      try {
        value = await this.executeTool(branch, toolUse);
      } catch (error) {
        value = {
          error:
            error instanceof Error
              ? error.message
              : "native subagent tool execution failed",
        };
      }
      const bounded = stringifyBounded(value);
      const valueRecord = record(value);
      const isError = Boolean(
        valueRecord.error || valueRecord.detail || valueRecord.isError === true,
      );
      toolResults.push({
        type: "tool_result",
        toolUseId: toolUse.id,
        content: [{ type: "text", text: bounded.text }],
        structuredContent: bounded.structured,
        isError,
      });
    }
    return {
      ...next,
      rounds,
      toolCalls,
      messages: [
        ...next.messages,
        { role: "user", content: toolResults },
      ],
    };
  }

  async run(
    payload: Record<string, unknown>,
    ctx: ServerContext,
    requestedModel: string | null,
    negotiatedCapabilities?: Record<string, unknown>,
  ): Promise<Record<string, unknown> | InputRequiredResult> {
    const input = this.normalize(payload, requestedModel);
    this.assertSamplingToolsCapability(ctx, negotiatedCapabilities);
    const stateRef = ctx.mcpReq.requestState<StateRef>();
    let state: NativeSubagentState;

    if (stateRef !== undefined) {
      if (
        !stateRef
        || stateRef.kind !== "cptr-native-subagents-v1"
        || typeof stateRef.fanoutId !== "string"
        || stateRef.fingerprint !== input.fingerprint
      ) {
        throw new Error(
          "native subagent retry state does not match the requested fan-out",
        );
      }
      const recovered = this.store.get(stateRef.fanoutId);
      if (!recovered || recovered.fingerprint !== input.fingerprint) {
        throw new Error(
          "native subagent fan-out state expired or is unavailable",
        );
      }
      state = recovered;
    } else {
      state = this.store.begin({
        status: "initializing",
        parentTaskId: input.parentTaskId,
        fingerprint: input.fingerprint,
        idempotencyKey: input.idempotencyKey,
        objectives: input.objectives,
        maxTokens: input.maxTokens,
        requestedModel: input.requestedModel,
        coding: input.coding,
        workspaceId: input.workspaceId,
        repoPath: input.repoPath,
        task: null,
        dispatch: null,
        branches: [],
        processingUntil: null,
        cleanup: null,
      }).state;
      if (state.fingerprint !== input.fingerprint) {
        throw new Error(
          "idempotency_key is already bound to a different native subagent fan-out",
        );
      }
    }

    if (state.status === "terminal") return this.finalResult(state);

    if (!state.branches.length) {
      const claimed = this.store.claim(state.id, state.version);
      if (!claimed) {
        const latest = this.store.get(state.id);
        if (!latest) {
          throw new Error(
            "native subagent fan-out state expired during initialization",
          );
        }
        if (latest.status === "terminal") return this.finalResult(latest);
        if (!latest.branches.length) {
          throw new Error(
            "native subagent fan-out initialization is already in progress; retry",
          );
        }
        state = latest;
      } else {
        state = claimed;
        let initialized: NativeSubagentState | null = null;
        try {
          initialized = await this.initialize(state);
          const saved = this.store.save(initialized, state.version);
          if (!saved) {
            throw new Error(
              "native subagent fan-out state changed during initialization",
            );
          }
          state = saved;
        } catch (error) {
          if (initialized) {
            await this.cleanupChildren(initialized);
          }
          this.store.remove(state.id, state.version);
          throw error;
        }
      }
    }

    if (ctx.mcpReq.signal.aborted) {
      const expectedVersion = state.version;
      state = await this.cleanupChildren({
        ...state,
        status: "terminal",
        branches: state.branches.map((branch) =>
          branch.status === "pending"
            ? {
                ...branch,
                status: "cancelled" as const,
                error: "calling ChatGPT cancelled the fan-out",
              }
            : branch,
        ),
      });
      state =
        this.store.save(
          { ...state, processingUntil: null },
          expectedVersion,
        )
        ?? state;
      return this.finalResult(state);
    }

    if (!ctx.mcpReq.inputResponses) {
      return this.inputRequiredResult(state, ctx);
    }

    const claimed = this.store.claim(state.id, state.version);
    if (!claimed) {
      const latest = this.store.get(state.id);
      if (!latest) {
        throw new Error(
          "native subagent fan-out state expired while waiting for a retry",
        );
      }
      if (latest.status === "terminal") return this.finalResult(latest);
      return this.inputRequiredResult(latest, ctx);
    }
    state = claimed;

    const pending = state.branches.filter(
      (branch) => branch.status === "pending",
    );
    const processed = await Promise.all(
      pending.map((branch) =>
        this.processBranch(
          branch,
          ctx.mcpReq.inputResponses,
          ctx.mcpReq.signal,
        ),
      ),
    );
    const byKey = new Map(
      processed.map((branch) => [branch.key, branch]),
    );
    let next: NativeSubagentState = {
      ...state,
      processingUntil: null,
      branches: state.branches.map(
        (branch) => byKey.get(branch.key) ?? branch,
      ),
    };

    if (!next.branches.some((branch) => branch.status === "pending")) {
      next = await this.cleanupChildren({
        ...next,
        status: "terminal",
      });
    }

    const saved = this.store.save(next, state.version);
    if (saved) {
      next = saved;
    } else {
      const latest = this.store.get(state.id);
      if (!latest) {
        throw new Error(
          "native subagent fan-out state was lost during retry commit",
        );
      }
      next = latest;
    }

    if (next.status === "terminal") return this.finalResult(next);
    return this.inputRequiredResult(next, ctx);
  }
}
