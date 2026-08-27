export type Workspace = {
  workspace_id: string;
  name: string;
  /** False when CPTR's persisted workspace path is no longer usable. */
  available?: boolean;
  path?: string;
};

export type CompletionIntegrity = {
  status: "CLEAN" | "TOOL_ERRORS";
  tool_error_count: number;
};

export type Task = {
  id: string;
  workspace_id: string;
  chat_id: string;
  message_id: string;
  status: string;
  prompt: string;
  model_id: string;
  output: string;
  raw_output?: unknown[];
  error?: string | null;
  completion_integrity?: CompletionIntegrity;
  review?: {
    status?: string;
    summary?: Record<string, unknown> | null;
    decision?: Record<string, unknown> | null;
    ready_at?: number | null;
    reviewed_at?: number | null;
  } | null;
  created_at?: number;
  updated_at?: number;
};

export type Monitor = {
  monitor_id: string;
  goal_id: string;
  workspace_id: string;
  status: string;
  scope_count: number;
  verified_count: number;
  current_scope: string | null;
  original_goal?: string;
  acceptance_criteria?: string[];
  scopes?: unknown[];
};

export type TaskOutput = {
  task_id: string;
  status: string;
  content: string;
  raw_output?: unknown[];
  review?: Task["review"];
  completion_integrity?: CompletionIntegrity;
};

/**
 * The bounded result exposed by the direct-execution MCP tool. It omits raw
 * agent events and limits text output so a single tool invocation cannot
 * consume an unbounded amount of the ChatGPT context window.
 */
export type DirectTaskExecution = {
  task_id: string;
  workspace_id: string;
  status: string;
  output: string;
  output_truncated: boolean;
  error?: string | null;
  completion_integrity?: CompletionIntegrity;
  review_summary?: Record<string, unknown> | null;
  completed: boolean;
  wait_seconds: number;
};

export type GitDiff = Record<string, unknown>;

export type DirectFileRead = {
  workspace_id: string;
  path: string;
  content: string;
  start_line: number;
  end_line: number;
  total_lines: number;
  size: number;
  content_sha256: string;
};

export type DirectCommand = {
  command_id: string;
  status: string;
  exit_code: number | null;
  output: string;
  next_offset: number;
  duration_ms?: number;
  output_truncated?: boolean;
  timed_out?: boolean;
};

export type DirectSshCommand = DirectCommand & {
  workspace_id: string;
  alias: string;
};
