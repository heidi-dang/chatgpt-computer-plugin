export type FactoryRunControl = {
  run_id: string;
  state: string;
};

export type FactoryRunStatus = FactoryRunControl & {
  workspace_id: string;
  current_cycle_id: string | null;
  resumable_state: string | null;
  next_action: string | null;
  mission: string;
  acceptance_criteria: string[];
  policy: Record<string, unknown>;
  budget: Record<string, unknown>;
  cycle: Record<string, unknown> | null;
  progress: Record<string, unknown>;
  pending_approval: Record<string, unknown> | null;
  gates: Array<Record<string, unknown>>;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
};

export type FactoryEventPage = {
  events: Array<Record<string, unknown>>;
  next_cursor: string | null;
  max_bytes: number;
  bytes_returned: number;
  truncated: boolean;
};

export type FactoryEvidencePage = {
  evidence: Array<Record<string, unknown>>;
  next_cursor: string | null;
  max_bytes: number;
  bytes_returned: number;
  truncated: boolean;
};

export type FactoryApprovalResult = {
  approval: Record<string, unknown>;
  run: Record<string, unknown>;
};

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
  pty?: boolean;
  rows?: number;
  cols?: number;
  recovered?: boolean;
};

export type DirectSshCommand = DirectCommand & {
  workspace_id: string;
  alias: string;
};

export type CodingBenchmarkTask = {
  id: string;
  file: string;
  points: number;
  instruction: string;
};

export type CodingBenchmarkCaseResult = {
  id: string;
  passed: number;
  total: number;
  points: number;
  max_points: number;
  error_kinds: string[];
};

export type CodingBenchmarkRun = {
  run_id: string;
  suite_id: string;
  suite_version: string;
  status: string;
  model_reported: string | null;
  model_canonical: string | null;
  workspace_id: string | null;
  score: number | null;
  max_score: number;
  case_results: CodingBenchmarkCaseResult[];
  error_summary: string | null;
  started_at_ms: number;
  completed_at_ms: number | null;
  duration_ms: number | null;
  comparable: true;
  comparability: "standardized_suite_only";
  tasks: CodingBenchmarkTask[];
  grader_seed?: string;
};

export type CodingBenchmarkLeaderboardModel = {
  model_canonical: string;
  model_reported: string | null;
  attempts: number;
  best_score: number;
  average_score: number;
  perfect_runs: number;
  pass_rate: number;
  median_duration_ms: number;
};

export type CodingBenchmarkLeaderboard = {
  comparable: true;
  comparability: "standardized_suite_only";
  suite_id: string;
  suite_version: string;
  max_score: number;
  models: CodingBenchmarkLeaderboardModel[];
};
