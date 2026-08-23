export type Workspace = {
  workspace_id: string;
  name: string;
  path?: string;
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
};

export type GitDiff = Record<string, unknown>;
