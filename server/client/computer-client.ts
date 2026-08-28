import type {
  CompletionIntegrity,
  DirectCommand,
  DirectFileRead,
  DirectSshCommand,
  DirectTaskExecution,
  GitDiff,
  Task,
  TaskOutput,
  Workspace,
} from "../types.js";

const COMPLETE_WITH_TOOL_ERRORS = "COMPLETE_WITH_TOOL_ERRORS";
const TERMINAL_TASK_STATUSES = new Set([
  "COMPLETE",
  COMPLETE_WITH_TOOL_ERRORS,
  "FAILED",
  "CANCELLED",
  "REVIEW_REQUIRED",
  "REJECTED",
]);
const DEFAULT_DIRECT_EXECUTION_WAIT_SECONDS = 30;
const MAX_DIRECT_EXECUTION_OUTPUT_CHARACTERS = 20_000;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function boundedOutput(output: string): { output: string; output_truncated: boolean } {
  if (output.length <= MAX_DIRECT_EXECUTION_OUTPUT_CHARACTERS) {
    return { output, output_truncated: false };
  }
  return {
    output: `${output.slice(0, MAX_DIRECT_EXECUTION_OUTPUT_CHARACTERS)}\n\n[Output truncated by the MCP adapter.]`,
    output_truncated: true,
  };
}

function isToolFailureValue(value: unknown): boolean {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.toLowerCase() === "error" || /^error\s*:/i.test(trimmed)) return true;
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try {
        return isToolFailureValue(JSON.parse(trimmed));
      } catch {
        return false;
      }
    }
    return false;
  }
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(isToolFailureValue);
  const record = value as Record<string, unknown>;
  const status = String(record.status ?? "").toLowerCase();
  const errorValue = record.error;
  const hasErrorValue =
    errorValue !== undefined &&
    errorValue !== null &&
    errorValue !== false &&
    (typeof errorValue !== "string" || errorValue.trim().length > 0);
  return (
    ["error", "failed", "failure"].includes(status) ||
    record.ok === false ||
    record.success === false ||
    hasErrorValue
  );
}

function completionIntegrity(rawOutput: unknown[] | undefined): CompletionIntegrity {
  const failedCalls = new Set<string>();
  for (const [index, item] of (rawOutput ?? []).entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const type = String(record.type ?? "");
    const callId = String(record.call_id ?? record.id ?? `${type}-${index}`);
    if (type === "function_call") {
      const status = String(record.status ?? "").toLowerCase();
      if (["error", "failed", "failure"].includes(status)) failedCalls.add(callId);
    } else if (type === "function_call_output" && isToolFailureValue(record.output)) {
      failedCalls.add(callId);
    }
  }
  return {
    status: failedCalls.size > 0 ? "TOOL_ERRORS" : "CLEAN",
    tool_error_count: failedCalls.size,
  };
}

function normalizeTaskCompletion(task: Task): Task {
  const integrity = completionIntegrity(task.raw_output);
  if (task.status !== "COMPLETE" || integrity.tool_error_count === 0) return task;
  return { ...task, status: COMPLETE_WITH_TOOL_ERRORS, completion_integrity: integrity };
}

function normalizeTaskOutputCompletion(task: TaskOutput): TaskOutput {
  const integrity = completionIntegrity(task.raw_output);
  if (task.status !== "COMPLETE" || integrity.tool_error_count === 0) return task;
  return { ...task, status: COMPLETE_WITH_TOOL_ERRORS, completion_integrity: integrity };
}

function publicErrorMessage(value: string): string {
  const redacted = value
    // Unix-style absolute paths, including the stale-workspace paths found by
    // the audit. Keep diagnostics meaningful without disclosing host layout.
    .replace(/(?:^|[\s:(])\/(?:[^\s/:]+\/)*[^\s/:]+/g, (match) => {
      const prefix = /^[\s:(]/.test(match) ? match[0] : "";
      return `${prefix}<redacted-path>`;
    })
    // Windows paths are equally unsuitable for a ChatGPT-visible diagnostic.
    .replace(/[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]+/g, "<redacted-path>")
    .trim();
  return (redacted || "CPTR request failed").slice(0, 500);
}


export class ComputerApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retriable: boolean;
  readonly field?: string;

  constructor(
    status: number,
    message: string,
    code = "computer_api_error",
    retriable = status >= 500,
    field?: string,
  ) {
    super(message);
    this.name = "ComputerApiError";
    this.status = status;
    this.code = code;
    this.retriable = retriable;
    this.field = field;
  }

  toEnvelope(): { code: string; message: string; retriable: boolean; field?: string } {
    return {
      code: this.code,
      message: this.message,
      retriable: this.retriable,
      ...(this.field ? { field: this.field } : {}),
    };
  }
}

export type FetchLike = typeof fetch;

export type DirectCodingWorker = {
  worker_id: string;
  workspace_id: string;
  name: string;
  responsibility: string;
  repo_path: string;
  status: string;
  branch: string;
  base_revision: string;
  changed_file_count: number;
  changed_paths: string[];
  active_command_ids: string[];
  recent_command_ids: string[];
  created_at: number;
  updated_at: number;
  integrated_at: number | null;
  closed_at: number | null;
};

export type WorkbenchSession = {
  session_id: string;
  name: string;
  workspace_id: string | null;
  status: string;
  active_target_type: "task" | "monitor" | "command" | null;
  active_target_id: string | null;
  active_workspace_id: string | null;
  event_count: number;
  created_at: number;
  updated_at: number;
  last_event_at: number | null;
  archived_at: number | null;
  deleted_at?: number | null;
};

export type WorkbenchSessionEvent = {
  session_id: string;
  sequence: number;
  source: string;
  actor: string;
  event_type: string;
  state: string | null;
  target_type: "task" | "monitor" | "command" | null;
  target_id: string | null;
  workspace_id: string | null;
  tool_name: string | null;
  summary: string;
  details: Record<string, unknown>;
  metrics: Record<string, unknown>;
  policy: Record<string, unknown>;
  created_at: number;
};

export class ComputerClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly workspaceCache = new Map<boolean, { expiresAt: number; value: { workspaces: Workspace[] } }>();
  private modelCache: {
    expiresAt: number;
    value: { models: Array<{ model_id: string; name: string; default: boolean }> };
  } | null = null;

  constructor(options: {
    baseUrl: string;
    token: string;
    fetchImpl?: FetchLike;
    timeoutMs?: number;
  }) {
    if (!options.baseUrl.trim()) throw new Error("CPTR_BASE_URL is required");
    if (!options.token.trim()) throw new Error("CPTR_API_TOKEN is required");
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async listWorkspaces(includeUnavailable = false): Promise<{ workspaces: Workspace[] }> {
    const now = Date.now();
    const cached = this.workspaceCache.get(includeUnavailable);
    if (cached && cached.expiresAt > now) return cached.value;
    const value = await this.request<{ workspaces: Workspace[] }>(
      `/workspaces?include_unavailable=${includeUnavailable ? "true" : "false"}`,
    );
    this.workspaceCache.set(includeUnavailable, { expiresAt: now + 10_000, value });
    return value;
  }

  async listModels(): Promise<{ models: Array<{ model_id: string; name: string; default: boolean }> }> {
    const now = Date.now();
    if (this.modelCache && this.modelCache.expiresAt > now) return this.modelCache.value;
    const value = await this.request<{ models: Array<{ model_id: string; name: string; default: boolean }> }>("/models");
    this.modelCache = { expiresAt: now + 60_000, value };
    return value;
  }
  async listTasks(input: { workspace_id?: string; status?: string; limit?: number }): Promise<Record<string, unknown>> {
    const query = new URLSearchParams();
    if (input.workspace_id) query.set("workspace_id", input.workspace_id);
    if (input.status) query.set("status", input.status);
    query.set("limit", String(input.limit ?? 20));
    return this.request(`/tasks?${query}`);
  }
  async listAutonomous(input: { workspace_id?: string; status?: string; limit?: number }): Promise<Record<string, unknown>> {
    const query = new URLSearchParams();
    if (input.workspace_id) query.set("workspace_id", input.workspace_id);
    if (input.status) query.set("status", input.status);
    query.set("limit", String(input.limit ?? 20));
    return this.request(`/autonomous?${query}`);
  }
  async getTaskEvents(input: { task_id: string; after_sequence?: number; max_events?: number }): Promise<Record<string, unknown>> {
    return this.request(`/tasks/${encodeURIComponent(input.task_id)}/events?after_sequence=${input.after_sequence ?? 0}&max_events=${input.max_events ?? 50}`);
  }
  async readManyFiles(input: { workspace_id: string; [key: string]: unknown }): Promise<Record<string, unknown>> { return this.request(`/workspaces/${encodeURIComponent(input.workspace_id)}/coding/read-many`, { method: "POST", body: input }); }
  async applyEdits(input: { workspace_id: string; [key: string]: unknown }): Promise<Record<string, unknown>> { return this.request(`/workspaces/${encodeURIComponent(input.workspace_id)}/coding/apply-edits`, { method: "POST", body: input }); }

  async getWorkspace(workspaceId: string): Promise<Workspace> {
    return this.request(`/workspaces/${encodeURIComponent(workspaceId)}`);
  }

  async createDirectWorker(input: {
    workspace_id: string;
    name: string;
    responsibility?: string;
    repo_path?: string;
  }): Promise<DirectCodingWorker> {
    const { workspace_id, ...body } = input;
    return this.request(`/workspaces/${encodeURIComponent(workspace_id)}/coding/workers`, {
      method: "POST",
      body,
    });
  }

  async listDirectWorkers(workspaceId: string): Promise<{ workspace_id: string; workers: DirectCodingWorker[] }> {
    return this.request(`/workspaces/${encodeURIComponent(workspaceId)}/coding/workers`);
  }

  async getDirectWorker(input: { workspace_id: string; worker_id: string }): Promise<DirectCodingWorker> {
    return this.request(
      `/workspaces/${encodeURIComponent(input.workspace_id)}/coding/workers/${encodeURIComponent(input.worker_id)}`,
    );
  }

  async directWorkersOverview(workspaceId: string): Promise<{
    workspace_id: string;
    workers: DirectCodingWorker[];
    total: number;
    active: number;
    ready: number;
    integrated: number;
  }> {
    return this.request(`/workspaces/${encodeURIComponent(workspaceId)}/coding/workers-overview`);
  }

  async integrateDirectWorkers(input: { workspace_id: string; worker_ids: string[] }): Promise<Record<string, unknown>> {
    const { workspace_id, ...body } = input;
    return this.request(`/workspaces/${encodeURIComponent(workspace_id)}/coding/workers-integrate`, {
      method: "POST",
      body,
    });
  }

  async closeDirectWorker(input: {
    workspace_id: string;
    worker_id: string;
    discard_changes?: boolean;
  }): Promise<Record<string, unknown>> {
    const { workspace_id, worker_id, ...body } = input;
    return this.request(
      `/workspaces/${encodeURIComponent(workspace_id)}/coding/workers/${encodeURIComponent(worker_id)}/close`,
      { method: "POST", body },
    );
  }

  async startTask(input: {
    workspace_id: string;
    prompt: string;
    model_id?: string;
    idempotency_key?: string;
    execution_policy?: {
      allow_file_writes: boolean;
      allow_commands: boolean;
      allow_network: boolean;
      allow_package_install: boolean;
    };
  }): Promise<Task> {
    return normalizeTaskCompletion(await this.request<Task>("/tasks", { method: "POST", body: input }));
  }

  /**
   * Start an already-authorized CPTR task and wait for a short, bounded
   * interval. Long-running work remains a normal durable task that can be
   * inspected with the existing task tools.
   */
  async executeTask(input: {
    workspace_id: string;
    prompt: string;
    model_id?: string;
    wait_seconds?: number;
    idempotency_key?: string;
    execution_policy?: {
      allow_file_writes: boolean;
      allow_commands: boolean;
      allow_network: boolean;
      allow_package_install: boolean;
    };
  }): Promise<DirectTaskExecution> {
    const waitSeconds = input.wait_seconds ?? DEFAULT_DIRECT_EXECUTION_WAIT_SECONDS;
    const task = await this.startTask({
      workspace_id: input.workspace_id,
      prompt: input.prompt,
      ...(input.model_id ? { model_id: input.model_id } : {}),
      idempotency_key: input.idempotency_key,
      execution_policy: input.execution_policy,
    });
    const deadline = Date.now() + waitSeconds * 1_000;
    let current = task;

    if (!TERMINAL_TASK_STATUSES.has(current.status) && waitSeconds > 0) {
      await this.waitForTaskTerminalEvent(task.id, Math.max(1, deadline - Date.now()));
      current = await this.getTask(task.id);
    }

    let pollDelayMs = 125;
    while (!TERMINAL_TASK_STATUSES.has(current.status) && Date.now() < deadline) {
      await wait(Math.min(pollDelayMs, Math.max(1, deadline - Date.now())));
      current = await this.getTask(task.id);
      pollDelayMs = Math.min(1_000, pollDelayMs * 2);
    }

    const output = boundedOutput(current.output ?? "");
    return {
      task_id: current.id,
      workspace_id: current.workspace_id,
      status: current.status,
      ...output,
      error: current.error,
      ...(current.completion_integrity ? { completion_integrity: current.completion_integrity } : {}),
      ...(current.status === "REVIEW_REQUIRED"
        ? { review_summary: current.review?.summary ?? null }
        : {}),
      completed: TERMINAL_TASK_STATUSES.has(current.status),
      wait_seconds: waitSeconds,
    };
  }

  private async waitForTaskTerminalEvent(taskId: string, maxWaitMs: number): Promise<boolean> {
    let response: Response;
    try {
      response = await this.streamLive("task", taskId, 0);
    } catch {
      return false;
    }
    if (!response.ok || !response.body) return false;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const deadline = Date.now() + Math.max(1, maxWaitMs);
    let buffer = "";
    try {
      while (Date.now() < deadline) {
        const remaining = Math.max(1, deadline - Date.now());
        const next = await new Promise<ReadableStreamReadResult<Uint8Array> | null>((resolve, reject) => {
          const timer = setTimeout(() => resolve(null), remaining);
          reader.read().then(
            (value) => {
              clearTimeout(timer);
              resolve(value);
            },
            (error) => {
              clearTimeout(timer);
              reject(error);
            },
          );
        }).catch(() => null);
        if (!next) {
          await reader.cancel().catch(() => undefined);
          return false;
        }
        if (next.done) return false;
        buffer += decoder.decode(next.value, { stream: true });

        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = block
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (data) {
            try {
              const event = JSON.parse(data) as Record<string, unknown>;
              const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
                ? event.payload as Record<string, unknown>
                : {};
              const status = String(payload.status ?? event.status ?? "").toUpperCase();
              const eventType = String(event.event_type ?? event.type ?? "").toLowerCase();
              if (TERMINAL_TASK_STATUSES.has(status) || eventType === "task.terminal") {
                await reader.cancel().catch(() => undefined);
                return true;
              }
            } catch {
              // Ignore heartbeat or malformed frames and keep reading.
            }
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
      return false;
    } finally {
      reader.releaseLock();
    }
  }

  async listCodingFiles(input: {
    workspace_id: string;
    worker_id?: string;
    path?: string;
    recursive?: boolean;
    max_entries?: number;
    cursor?: string;
  }): Promise<{
    workspace_id: string;
    path: string;
    entries: Array<{ path: string; type: string; size: number }>;
    total: number;
    truncated: boolean;
    max_entries: number;
    cursor: string | null;
  }> {
    return this.request(`/workspaces/${encodeURIComponent(input.workspace_id)}/coding/list`, {
      method: "POST",
      body: {
        ...(input.worker_id ? { worker_id: input.worker_id } : {}),
        path: input.path ?? ".",
        recursive: input.recursive ?? false,
        max_entries: input.max_entries ?? 500,
        ...(input.cursor ? { cursor: input.cursor } : {}),
      },
    });
  }

  async readCodingFile(input: {
    workspace_id: string;
    worker_id?: string;
    path: string;
    start_line?: number;
    end_line?: number;
  }): Promise<DirectFileRead> {
    return this.request(`/workspaces/${encodeURIComponent(input.workspace_id)}/coding/read`, {
      method: "POST",
      body: {
        ...(input.worker_id ? { worker_id: input.worker_id } : {}),
        path: input.path,
        start_line: input.start_line ?? 0,
        end_line: input.end_line ?? 0,
      },
    });
  }

  async searchCodingFiles(input: {
    workspace_id: string;
    worker_id?: string;
    query: string;
    path?: string;
    regex?: boolean;
    case_insensitive?: boolean;
    include?: string;
    filenames_only?: boolean;
    max_results?: number;
    context_lines?: number;
  }): Promise<{
    workspace_id: string;
    path: string;
    matches: Array<{ path: string; line: number; text: string; context?: string[] }>;
    max_results: number;
    truncated: boolean;
  }> {
    return this.request(`/workspaces/${encodeURIComponent(input.workspace_id)}/coding/search`, {
      method: "POST",
      body: {
        ...(input.worker_id ? { worker_id: input.worker_id } : {}),
        query: input.query,
        path: input.path ?? ".",
        regex: input.regex ?? false,
        case_insensitive: input.case_insensitive ?? false,
        include: input.include ?? "",
        filenames_only: input.filenames_only ?? false,
        max_results: input.max_results ?? 100,
        context_lines: input.context_lines ?? 0,
      },
    });
  }

  async runFdxIntelligence(input: {
    workspace_id: string;
    worker_id?: string;
    action: string;
    [key: string]: unknown;
  }): Promise<Record<string, unknown>> {
    const { workspace_id, ...body } = input;
    return this.request(`/workspaces/${encodeURIComponent(workspace_id)}/coding/fdx`, {
      method: "POST",
      body,
    });
  }

  async writeCodingFile(input: {
    workspace_id: string;
    worker_id?: string;
    path: string;
    content: string;
    expected_sha256?: string;
    overwrite?: boolean;
  }): Promise<{ workspace_id: string; path: string; bytes_written: number; sha256: string }> {
    return this.request(`/workspaces/${encodeURIComponent(input.workspace_id)}/coding/write`, {
      method: "POST",
      body: {
        ...(input.worker_id ? { worker_id: input.worker_id } : {}),
        path: input.path,
        content: input.content,
        ...(input.expected_sha256 ? { expected_sha256: input.expected_sha256 } : {}),
        overwrite: input.overwrite ?? false,
      },
    });
  }

  async editCodingFile(input: {
    workspace_id: string;
    worker_id?: string;
    path: string;
    target: string;
    replacement: string;
    start_line?: number;
    end_line?: number;
    expected_sha256?: string;
    replace_all?: boolean;
  }): Promise<{
    workspace_id: string;
    path: string;
    replaced_characters: number;
    inserted_characters: number;
    sha256: string;
    diff: string;
  }> {
    return this.request(`/workspaces/${encodeURIComponent(input.workspace_id)}/coding/edit`, {
      method: "POST",
      body: {
        ...(input.worker_id ? { worker_id: input.worker_id } : {}),
        path: input.path,
        target: input.target,
        replacement: input.replacement,
        start_line: input.start_line ?? 0,
        end_line: input.end_line ?? 0,
        ...(input.expected_sha256 ? { expected_sha256: input.expected_sha256 } : {}),
        replace_all: input.replace_all ?? false,
      },
    });
  }

  async createCodingDirectory(input: {
    workspace_id: string;
    worker_id?: string;
    path: string;
  }): Promise<{ workspace_id: string; path: string; type: string; created: boolean }> {
    return this.request(`/workspaces/${encodeURIComponent(input.workspace_id)}/coding/directories`, {
      method: "POST",
      body: { ...(input.worker_id ? { worker_id: input.worker_id } : {}), path: input.path },
    });
  }

  async moveCodingFile(input: {
    workspace_id: string;
    worker_id?: string;
    source: string;
    destination: string;
    overwrite?: boolean;
  }): Promise<{ workspace_id: string; source: string; destination: string; sha256: string }> {
    return this.request(`/workspaces/${encodeURIComponent(input.workspace_id)}/coding/move`, {
      method: "POST",
      body: { ...(input.worker_id ? { worker_id: input.worker_id } : {}), source: input.source, destination: input.destination, overwrite: input.overwrite ?? false },
    });
  }

  async deleteCodingFile(input: {
    workspace_id: string;
    worker_id?: string;
    path: string;
  }): Promise<{ workspace_id: string; path: string; deleted: boolean; existed: boolean }> {
    return this.request(`/workspaces/${encodeURIComponent(input.workspace_id)}/coding/delete`, {
      method: "POST",
      body: { ...(input.worker_id ? { worker_id: input.worker_id } : {}), path: input.path },
    });
  }

  async getGitStatus(
    input: string | { workspace_id: string; worker_id?: string },
  ): Promise<Record<string, unknown>> {
    const request = typeof input === "string" ? { workspace_id: input } : input;
    const query = new URLSearchParams();
    if (request.worker_id) query.set("worker_id", request.worker_id);
    return this.request(
      `/workspaces/${encodeURIComponent(request.workspace_id)}/git/status${query.size ? `?${query}` : ""}`,
    );
  }

  async createWorkbenchSession(input: { name?: string; workspace_id?: string } = {}): Promise<WorkbenchSession> {
    return this.request("/workbench-sessions", { method: "POST", body: input });
  }

  async listWorkbenchSessions(input: { include_archived?: boolean; limit?: number } = {}): Promise<{ sessions: WorkbenchSession[] }> {
    const query = new URLSearchParams();
    if (input.include_archived) query.set("include_archived", "true");
    if (input.limit !== undefined) query.set("limit", String(input.limit));
    const suffix = query.size ? `?${query}` : "";
    return this.request(`/workbench-sessions${suffix}`);
  }

  async getWorkbenchSession(sessionId: string): Promise<WorkbenchSession> {
    return this.request(`/workbench-sessions/${encodeURIComponent(sessionId)}`);
  }

  async getWorkbenchSessionEvents(input: { session_id: string; after_sequence?: number; limit?: number }): Promise<{
    session_id: string;
    events: WorkbenchSessionEvent[];
    last_sequence: number;
  }> {
    const query = new URLSearchParams({
      after_sequence: String(input.after_sequence ?? 0),
      limit: String(input.limit ?? 100),
    });
    return this.request(`/workbench-sessions/${encodeURIComponent(input.session_id)}/events?${query}`);
  }

  async bindWorkbenchSession(input: {
    session_id: string;
    target_type: "task" | "monitor" | "command";
    target_id: string;
    workspace_id?: string;
  }): Promise<WorkbenchSession> {
    const { session_id, ...body } = input;
    return this.request(`/workbench-sessions/${encodeURIComponent(session_id)}/bind`, { method: "POST", body });
  }

  async renameWorkbenchSession(input: { session_id: string; name: string }): Promise<WorkbenchSession> {
    const { session_id, ...body } = input;
    return this.request(`/workbench-sessions/${encodeURIComponent(session_id)}`, { method: "PATCH", body });
  }

  async archiveWorkbenchSession(sessionId: string): Promise<WorkbenchSession> {
    return this.request(`/workbench-sessions/${encodeURIComponent(sessionId)}/archive`, { method: "POST" });
  }

  async requestWorkbenchSessionDelete(sessionId: string): Promise<{
    session_id: string;
    confirmation_id: string;
    expires_at: number;
    event_count: number;
    impact: string;
  }> {
    return this.request(`/workbench-sessions/${encodeURIComponent(sessionId)}/delete-request`, { method: "POST" });
  }

  async confirmWorkbenchSessionDelete(confirmationId: string): Promise<{
    session_id: string;
    status: string;
    deleted_at: number;
  }> {
    return this.request("/workbench-sessions/delete-confirm", { method: "POST", body: { confirmation_id: confirmationId } });
  }

  async appendWorkbenchSessionEvent(input: {
    session_id: string;
    event_type: string;
    summary: string;
    state?: string;
    target_type?: "task" | "monitor" | "command";
    target_id?: string;
    workspace_id?: string;
    tool_name?: string;
  }): Promise<WorkbenchSessionEvent> {
    const { session_id, ...body } = input;
    return this.request(`/workbench-sessions/${encodeURIComponent(session_id)}/events`, { method: "POST", body });
  }

  async inspectWorkspace(input: {
    workspace_id: string;
    worker_id?: string;
    kind: "project" | "tree" | "metadata" | "read_many" | "symbols" | "tests" | "dependencies" | "scripts" | "release";
    path?: string;
    paths?: string[];
    query?: string;
    depth?: number;
  }): Promise<Record<string, unknown>> {
    const { workspace_id, ...body } = input;
    return this.request(`/workspaces/${encodeURIComponent(workspace_id)}/coding/inspect`, {
      method: "POST",
      body: { path: ".", ...body },
    });
  }

  async runWorkspaceTestTarget(input: {
    workspace_id: string;
    worker_id?: string;
    target: "python_pytest" | "node_test" | "node_vitest" | "node_build";
    path?: string;
    test_path?: string;
    wait_seconds?: number;
  }): Promise<DirectCommand & { target: string }> {
    const { workspace_id, ...body } = input;
    return this.request(`/workspaces/${encodeURIComponent(workspace_id)}/coding/test-targets`, {
      method: "POST",
      body: { path: ".", wait_seconds: 0, ...body },
    });
  }

  async runCodingCommand(input: {
    workspace_id: string;
    worker_id?: string;
    command: string;
    cwd?: string;
    wait_seconds?: number;
    allow_network?: boolean;
    idempotency_key?: string;
  }): Promise<DirectCommand> {
    return this.request(`/workspaces/${encodeURIComponent(input.workspace_id)}/coding/commands`, {
      method: "POST",
      body: {
        ...(input.worker_id ? { worker_id: input.worker_id } : {}),
        command: input.command,
        cwd: input.cwd ?? ".",
        wait_seconds: input.wait_seconds ?? 0,
        allow_network: input.allow_network ?? false,
        ...(input.idempotency_key ? { idempotency_key: input.idempotency_key } : {}),
      },
    });
  }

  async getCodingCommand(input: {
    workspace_id: string;
    worker_id?: string;
    command_id: string;
    offset?: number;
    wait_seconds?: number;
    tail_bytes?: number;
  }): Promise<DirectCommand> {
    const query = new URLSearchParams({
      offset: String(input.offset ?? 0),
      wait_seconds: String(input.wait_seconds ?? 0),
    });
    if (input.tail_bytes !== undefined) query.set("tail_bytes", String(input.tail_bytes));
    if (input.worker_id) query.set("worker_id", input.worker_id);
    return this.request(
      `/workspaces/${encodeURIComponent(input.workspace_id)}/coding/commands/${encodeURIComponent(input.command_id)}?${query}`,
    );
  }

  async cancelCodingCommand(input: {
    workspace_id: string;
    worker_id?: string;
    command_id: string;
  }): Promise<DirectCommand> {
    const query = new URLSearchParams();
    if (input.worker_id) query.set("worker_id", input.worker_id);
    return this.request(
      `/workspaces/${encodeURIComponent(input.workspace_id)}/coding/commands/${encodeURIComponent(input.command_id)}/cancel${query.size ? `?${query}` : ""}`,
      { method: "POST" },
    );
  }

  async listSshHosts(input: { workspace_id: string }): Promise<{ workspace_id: string; aliases: string[] }> {
    return this.request(`/workspaces/${encodeURIComponent(input.workspace_id)}/ssh/hosts`);
  }

  async runSshCommand(input: {
    workspace_id: string;
    alias: string;
    command: string;
    wait_seconds?: number;
  }): Promise<DirectSshCommand> {
    return this.request(`/workspaces/${encodeURIComponent(input.workspace_id)}/ssh/commands`, {
      method: "POST",
      body: {
        alias: input.alias,
        command: input.command,
        wait_seconds: input.wait_seconds ?? 0,
      },
    });
  }

  async getSshCommand(input: {
    workspace_id: string;
    command_id: string;
    offset?: number;
    wait_seconds?: number;
  }): Promise<DirectSshCommand> {
    const query = new URLSearchParams({
      offset: String(input.offset ?? 0),
      wait_seconds: String(input.wait_seconds ?? 0),
    });
    return this.request(
      `/workspaces/${encodeURIComponent(input.workspace_id)}/ssh/commands/${encodeURIComponent(input.command_id)}?${query}`,
    );
  }

  async cancelSshCommand(input: {
    workspace_id: string;
    command_id: string;
  }): Promise<DirectSshCommand> {
    return this.request(
      `/workspaces/${encodeURIComponent(input.workspace_id)}/ssh/commands/${encodeURIComponent(input.command_id)}/cancel`,
      { method: "POST" },
    );
  }

  async controlChromeBrowser(input: {
    workspace_id: string;
    action: "status" | "navigate" | "snapshot" | "click" | "type" | "press_key" | "scroll" | "screenshot" | "close";
    url?: string;
    ref?: string;
    text?: string;
    key?: string;
    modifiers?: Array<"Alt" | "Control" | "Meta" | "Shift">;
    direction?: "up" | "down";
    amount?: number;
    width?: number;
    height?: number;
    allow_network?: boolean;
  }): Promise<Record<string, unknown>> {
    const { workspace_id, ...body } = input;
    return this.request(`/workspaces/${encodeURIComponent(workspace_id)}/browser`, {
      method: "POST",
      body,
    });
  }

  async createAutonomous(input: {
    workspace_id: string;
    goal: string;
    acceptance_criteria: string[];
    model_id?: string;
    idempotency_key?: string;
    execution_policy?: {
      allow_file_writes: boolean;
      allow_commands: boolean;
      allow_network: boolean;
      allow_package_install: boolean;
    };
  }): Promise<Record<string, unknown>> {
    return this.request("/autonomous", { method: "POST", body: input });
  }

  async getAutonomous(monitorId: string): Promise<Record<string, unknown>> {
    return this.request(`/autonomous/${encodeURIComponent(monitorId)}`);
  }

  async getAutonomousEvents(
    input: string | { monitor_id: string; after_sequence?: number; max_events?: number },
  ): Promise<Record<string, unknown>> {
    const request = typeof input === "string" ? { monitor_id: input } : input;
    const query = new URLSearchParams({
      after_sequence: String(request.after_sequence ?? 0),
      max_events: String(request.max_events ?? 100),
    });
    return this.request(`/autonomous/${encodeURIComponent(request.monitor_id)}/events?${query}`);
  }

  async getAutonomousEvidence(
    input: string | { monitor_id: string; scope_id?: string },
  ): Promise<Record<string, unknown>> {
    const request = typeof input === "string" ? { monitor_id: input } : input;
    const query = new URLSearchParams();
    if (request.scope_id) query.set("scope", request.scope_id);
    return this.request(`/autonomous/${encodeURIComponent(request.monitor_id)}/evidence${query.size ? `?${query}` : ""}`);
  }

  async steerAutonomous(
    monitorId: string,
    content: string,
    idempotencyKey?: string,
  ): Promise<Record<string, unknown>> {
    return this.request(`/autonomous/${encodeURIComponent(monitorId)}/messages`, {
      method: "POST",
      body: { content, ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}) },
    });
  }

  async cancelAutonomous(monitorId: string): Promise<Record<string, unknown>> {
    return this.request(`/autonomous/${encodeURIComponent(monitorId)}/cancel`, { method: "POST" });
  }

  async approveAutonomous(
    monitorId: string,
    approvalId: string,
    approved: boolean,
    note?: string,
  ): Promise<Record<string, unknown>> {
    return this.request(`/autonomous/${encodeURIComponent(monitorId)}/approve`, {
      method: "POST",
      body: { approval_id: approvalId, approved, ...(note ? { note } : {}) },
    });
  }

  async getTask(taskId: string): Promise<Task> {
    return normalizeTaskCompletion(await this.request<Task>(`/tasks/${encodeURIComponent(taskId)}`));
  }

  async getTaskOutput(
    input: string | { task_id: string; offset?: number; max_chars?: number },
  ): Promise<TaskOutput> {
    const request = typeof input === "string" ? { task_id: input } : input;
    const query = new URLSearchParams({
      offset: String(request.offset ?? 0),
      max_chars: String(request.max_chars ?? 20_000),
    });
    return normalizeTaskOutputCompletion(
      await this.request<TaskOutput>(`/tasks/${encodeURIComponent(request.task_id)}/output?${query}`),
    );
  }

  async getTaskReview(
    input: string | { task_id: string; max_diff_bytes?: number },
  ): Promise<Record<string, unknown>> {
    const request = typeof input === "string" ? { task_id: input } : input;
    const query = new URLSearchParams({ max_diff_bytes: String(request.max_diff_bytes ?? 100_000) });
    return this.request(`/tasks/${encodeURIComponent(request.task_id)}/review?${query}`);
  }

  async decideTaskReview(
    taskId: string,
    input: { decision: "ACCEPT" | "REJECT" | "REQUEST_CHANGES"; note?: string; idempotency_key?: string },
  ): Promise<Task> {
    return this.request(`/tasks/${encodeURIComponent(taskId)}/review`, {
      method: "POST",
      body: input,
    });
  }

  async sendMessage(
    taskId: string,
    content: string,
    idempotencyKey?: string,
  ): Promise<Record<string, unknown>> {
    return this.request(`/tasks/${encodeURIComponent(taskId)}/messages`, {
      method: "POST",
      body: { content, ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}) },
    });
  }

  async cancelTask(taskId: string): Promise<Task> {
    return this.request(`/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST" });
  }

  async getDiff(
    input: string | { workspace_id: string; worker_id?: string; paths?: string[]; max_bytes?: number },
  ): Promise<GitDiff> {
    const request = typeof input === "string" ? { workspace_id: input } : input;
    const query = new URLSearchParams({ max_bytes: String(request.max_bytes ?? 100_000) });
    if (request.worker_id) query.set("worker_id", request.worker_id);
    for (const path of request.paths ?? []) query.append("paths", path);
    return this.request(`/workspaces/${encodeURIComponent(request.workspace_id)}/git/diff?${query}`);
  }

  async getLiveSnapshot(
    targetType: "task" | "monitor" | "command",
    targetId: string,
    afterSequence = 0,
    workspaceId?: string,
  ): Promise<Record<string, unknown>> {
    if (targetType === "command") {
      if (!workspaceId) throw new ComputerApiError(400, "workspace identity is required for command live stream");
      return this.request(
        `/workspaces/${encodeURIComponent(workspaceId)}/coding/commands/${encodeURIComponent(targetId)}/stream/snapshot?after=${Math.max(0, afterSequence)}`,
      );
    }
    const path = targetType === "task" ? "tasks" : "autonomous";
    return this.request(
      `/${path}/${encodeURIComponent(targetId)}/stream/snapshot?after=${Math.max(0, afterSequence)}`,
    );
  }

  async streamLive(
    targetType: "task" | "monitor" | "command",
    targetId: string,
    afterSequence = 0,
    workspaceId?: string,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(this.timeoutMs, 60_000));
    try {
      let path: string;
      if (targetType === "command") {
        if (!workspaceId) throw new ComputerApiError(400, "workspace identity is required for command live stream");
        path = `workspaces/${encodeURIComponent(workspaceId)}/coding/commands/${encodeURIComponent(targetId)}`;
      } else {
        path = `${targetType === "task" ? "tasks" : "autonomous"}/${encodeURIComponent(targetId)}`;
      }
      return await this.fetchImpl(
        `${this.baseUrl}/api/control/v1/${path}/stream?after=${afterSequence}`,
        {
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: "text/event-stream",
          },
          signal: controller.signal,
        },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async request<T>(
    path: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/control/v1${path}`, {
        method: options.method ?? "GET",
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const rawDetail = payload?.detail;
        if (rawDetail && typeof rawDetail === "object" && !Array.isArray(rawDetail)) {
          const detail = rawDetail as Record<string, unknown>;
          throw new ComputerApiError(
            response.status,
            publicErrorMessage(String(detail.message ?? "request failed")),
            String(detail.code ?? "computer_api_error"),
            Boolean(detail.retriable ?? response.status >= 500),
            typeof detail.field === "string" ? detail.field : undefined,
          );
        }
        const detail = typeof rawDetail === "string" ? rawDetail : "request failed";
        throw new ComputerApiError(response.status, publicErrorMessage(detail));
      }
      return payload as T;
    } catch (error) {
      if (error instanceof ComputerApiError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new ComputerApiError(504, "CPTR request timed out", "computer_api_timeout");
      }
      throw new ComputerApiError(502, "CPTR request failed", "computer_api_unavailable");
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function clientFromEnvironment(env = process.env): ComputerClient {
  return new ComputerClient({
    baseUrl: env.CPTR_BASE_URL ?? "",
    token: env.CPTR_API_TOKEN ?? "",
  });
}
