import type {
  DirectCommand,
  DirectFileRead,
  DirectTaskExecution,
  GitDiff,
  Task,
  TaskOutput,
  Workspace,
} from "../types.js";

const TERMINAL_TASK_STATUSES = new Set(["COMPLETE", "FAILED", "CANCELLED"]);
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


export class ComputerApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, message: string, code = "computer_api_error") {
    super(message);
    this.name = "ComputerApiError";
    this.status = status;
    this.code = code;
  }
}

export type FetchLike = typeof fetch;

export class ComputerClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

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

  async listWorkspaces(): Promise<{ workspaces: Workspace[] }> {
    return this.request("/workspaces");
  }

  async getWorkspace(workspaceId: string): Promise<Workspace> {
    return this.request(`/workspaces/${encodeURIComponent(workspaceId)}`);
  }

  async startTask(input: {
    workspace_id: string;
    prompt: string;
    model_id: string;
    idempotency_key?: string;
  }): Promise<Task> {
    return this.request("/tasks", { method: "POST", body: input });
  }

  /**
   * Start an already-authorized CPTR task and wait for a short, bounded
   * interval. Long-running work remains a normal durable task that can be
   * inspected with the existing task tools.
   */
  async executeTask(input: {
    workspace_id: string;
    prompt: string;
    model_id: string;
    wait_seconds?: number;
    idempotency_key?: string;
  }): Promise<DirectTaskExecution> {
    const waitSeconds = input.wait_seconds ?? DEFAULT_DIRECT_EXECUTION_WAIT_SECONDS;
    const task = await this.startTask({
      workspace_id: input.workspace_id,
      prompt: input.prompt,
      model_id: input.model_id,
      idempotency_key: input.idempotency_key,
    });
    const deadline = Date.now() + waitSeconds * 1_000;
    let current = task;

    while (!TERMINAL_TASK_STATUSES.has(current.status) && Date.now() < deadline) {
      await wait(Math.min(1_000, Math.max(1, deadline - Date.now())));
      current = await this.getTask(task.id);
    }

    const output = boundedOutput(current.output ?? "");
    return {
      task_id: current.id,
      workspace_id: current.workspace_id,
      status: current.status,
      ...output,
      error: current.error,
      completed: TERMINAL_TASK_STATUSES.has(current.status),
      wait_seconds: waitSeconds,
    };
  }

  async listCodingFiles(input: {
    workspace_id: string;
    path?: string;
    recursive?: boolean;
  }): Promise<{ workspace_id: string; path: string; entries: string }> {
    return this.request(`/workspaces/${encodeURIComponent(input.workspace_id)}/coding/list`, {
      method: "POST",
      body: { path: input.path ?? ".", recursive: input.recursive ?? false },
    });
  }

  async readCodingFile(input: {
    workspace_id: string;
    path: string;
    start_line?: number;
    end_line?: number;
  }): Promise<DirectFileRead> {
    return this.request(`/workspaces/${encodeURIComponent(input.workspace_id)}/coding/read`, {
      method: "POST",
      body: {
        path: input.path,
        start_line: input.start_line ?? 0,
        end_line: input.end_line ?? 0,
      },
    });
  }

  async searchCodingFiles(input: {
    workspace_id: string;
    query: string;
    path?: string;
    regex?: boolean;
    case_insensitive?: boolean;
    include?: string;
    filenames_only?: boolean;
  }): Promise<{ workspace_id: string; path: string; matches: string }> {
    return this.request(`/workspaces/${encodeURIComponent(input.workspace_id)}/coding/search`, {
      method: "POST",
      body: {
        query: input.query,
        path: input.path ?? ".",
        regex: input.regex ?? false,
        case_insensitive: input.case_insensitive ?? false,
        include: input.include ?? "",
        filenames_only: input.filenames_only ?? false,
      },
    });
  }

  async writeCodingFile(input: {
    workspace_id: string;
    path: string;
    content: string;
  }): Promise<{ workspace_id: string; path: string; bytes_written: number }> {
    return this.request(`/workspaces/${encodeURIComponent(input.workspace_id)}/coding/write`, {
      method: "POST",
      body: { path: input.path, content: input.content },
    });
  }

  async editCodingFile(input: {
    workspace_id: string;
    path: string;
    target: string;
    replacement: string;
    start_line?: number;
    end_line?: number;
  }): Promise<{
    workspace_id: string;
    path: string;
    replaced_characters: number;
    inserted_characters: number;
  }> {
    return this.request(`/workspaces/${encodeURIComponent(input.workspace_id)}/coding/edit`, {
      method: "POST",
      body: {
        path: input.path,
        target: input.target,
        replacement: input.replacement,
        start_line: input.start_line ?? 0,
        end_line: input.end_line ?? 0,
      },
    });
  }

  async runCodingCommand(input: {
    workspace_id: string;
    command: string;
    cwd?: string;
    wait_seconds?: number;
    allow_network?: boolean;
  }): Promise<DirectCommand> {
    return this.request(`/workspaces/${encodeURIComponent(input.workspace_id)}/coding/commands`, {
      method: "POST",
      body: {
        command: input.command,
        cwd: input.cwd ?? ".",
        wait_seconds: input.wait_seconds ?? 30,
        allow_network: input.allow_network ?? false,
      },
    });
  }

  async getCodingCommand(input: {
    workspace_id: string;
    command_id: string;
    offset?: number;
    wait_seconds?: number;
  }): Promise<DirectCommand> {
    const query = new URLSearchParams({
      offset: String(input.offset ?? 0),
      wait_seconds: String(input.wait_seconds ?? 0),
    });
    return this.request(
      `/workspaces/${encodeURIComponent(input.workspace_id)}/coding/commands/${encodeURIComponent(input.command_id)}?${query}`,
    );
  }

  async cancelCodingCommand(input: {
    workspace_id: string;
    command_id: string;
  }): Promise<DirectCommand> {
    return this.request(
      `/workspaces/${encodeURIComponent(input.workspace_id)}/coding/commands/${encodeURIComponent(input.command_id)}/cancel`,
      { method: "POST" },
    );
  }

  async createAutonomous(input: {
    workspace_id: string;
    goal: string;
    acceptance_criteria: string[];
    model_id: string;
    idempotency_key?: string;
  }): Promise<Record<string, unknown>> {
    return this.request("/autonomous", { method: "POST", body: input });
  }

  async getAutonomous(monitorId: string): Promise<Record<string, unknown>> {
    return this.request(`/autonomous/${encodeURIComponent(monitorId)}`);
  }

  async getAutonomousEvents(monitorId: string): Promise<Record<string, unknown>> {
    return this.request(`/autonomous/${encodeURIComponent(monitorId)}/events`);
  }

  async getAutonomousEvidence(monitorId: string): Promise<Record<string, unknown>> {
    return this.request(`/autonomous/${encodeURIComponent(monitorId)}/evidence`);
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
  ): Promise<Record<string, unknown>> {
    return this.request(`/autonomous/${encodeURIComponent(monitorId)}/approve`, {
      method: "POST",
      body: { approval_id: approvalId, approved },
    });
  }

  async getTask(taskId: string): Promise<Task> {
    return this.request(`/tasks/${encodeURIComponent(taskId)}`);
  }

  async getTaskOutput(taskId: string): Promise<TaskOutput> {
    return this.request(`/tasks/${encodeURIComponent(taskId)}/output`);
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

  async getDiff(workspaceId: string): Promise<GitDiff> {
    return this.request(`/workspaces/${encodeURIComponent(workspaceId)}/git/diff`);
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
        const detail = typeof payload?.detail === "string" ? payload.detail : "request failed";
        throw new ComputerApiError(response.status, detail);
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
