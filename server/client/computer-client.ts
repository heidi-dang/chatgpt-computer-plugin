import type { GitDiff, Monitor, Task, TaskOutput, Workspace } from "../types.js";

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

  async monitorAutonomous(input: {
    workspace_id: string;
    goal: string;
    acceptance_criteria: string[];
    model_id: string;
    idempotency_key?: string;
  }): Promise<Monitor> {
    return this.request("/autonomous", { method: "POST", body: input });
  }

  async getTask(taskId: string): Promise<Task> {
    return this.request(`/tasks/${encodeURIComponent(taskId)}`);
  }

  async getTaskOutput(taskId: string): Promise<TaskOutput> {
    return this.request(`/tasks/${encodeURIComponent(taskId)}/output`);
  }

  async sendMessage(taskId: string, content: string): Promise<Record<string, unknown>> {
    return this.request(`/tasks/${encodeURIComponent(taskId)}/messages`, {
      method: "POST",
      body: { content },
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
