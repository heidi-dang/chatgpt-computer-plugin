import { z } from "zod";

export const workspaceIdSchema = { workspace_id: z.string().min(1).max(200) };
export const taskIdSchema = { task_id: z.string().min(1).max(200) };
export const monitorIdSchema = { monitor_id: z.string().min(1).max(200) };
export const steerAutonomousSchema = {
  monitor_id: z.string().min(1).max(200),
  content: z.string().min(1).max(50_000),
  idempotency_key: z.string().min(1).max(200).optional(),
};
export const approveAutonomousSchema = {
  monitor_id: z.string().min(1).max(200),
  approval_id: z.string().min(1).max(200),
  approved: z.boolean(),
};

export const taskExecutionPolicySchema = z.object({
  allow_file_writes: z.boolean().default(true).describe("Allow CPTR file create/write/edit tools for this task."),
  allow_commands: z.boolean().default(true).describe("Allow CPTR to start shell commands for this task."),
  allow_network: z.boolean().default(false).describe("Allow network-capable tools, external tool servers, and known external commands."),
  allow_package_install: z.boolean().default(false).describe("Allow package installation commands such as npm install, pip install, and uv sync."),
}).default({
  allow_file_writes: true,
  allow_commands: true,
  allow_network: false,
  allow_package_install: false,
});

export const startTaskSchema = {
  workspace_id: z.string().min(1).max(200),
  prompt: z.string().min(1).max(100_000),
  model_id: z.string().min(1).max(500),
  idempotency_key: z.string().min(1).max(200).optional(),
  execution_policy: taskExecutionPolicySchema,
};

export const executeTaskSchema = {
  workspace_id: z.string().min(1).max(200),
  prompt: z.string().min(1).max(100_000),
  model_id: z.string().min(1).max(500),
  wait_seconds: z.number().int().min(1).max(60).default(30),
  idempotency_key: z.string().min(1).max(200).optional(),
  execution_policy: taskExecutionPolicySchema,
};

export const monitorAutonomousSchema = {
  workspace_id: z.string().min(1).max(200),
  goal: z.string().min(1).max(100_000),
  acceptance_criteria: z.array(z.string().min(1).max(10_000)).min(1).max(100),
  model_id: z.string().min(1).max(500),
  idempotency_key: z.string().min(1).max(200).optional(),
  execution_policy: taskExecutionPolicySchema,
};

export const messageSchema = {
  task_id: z.string().min(1).max(200),
  content: z.string().min(1).max(50_000),
  idempotency_key: z.string().min(1).max(200).optional(),
};

export const reviewDecisionSchema = {
  task_id: z.string().min(1).max(200),
  decision: z.enum(["ACCEPT", "REJECT", "REQUEST_CHANGES"]),
  note: z.string().min(1).max(50_000).optional(),
  idempotency_key: z.string().min(1).max(200).optional(),
};


export const codingListSchema = {
  workspace_id: z.string().min(1).max(200),
  path: z.string().min(1).max(1_000).default("."),
  recursive: z.boolean().default(false),
};

export const codingReadSchema = {
  workspace_id: z.string().min(1).max(200),
  path: z.string().min(1).max(1_000),
  start_line: z.number().int().min(0).max(1_000_000).default(0),
  end_line: z.number().int().min(0).max(1_000_000).default(0),
};

export const codingSearchSchema = {
  workspace_id: z.string().min(1).max(200),
  query: z.string().min(1).max(10_000),
  path: z.string().min(1).max(1_000).default("."),
  regex: z.boolean().default(false),
  case_insensitive: z.boolean().default(false),
  include: z.string().max(1_000).default(""),
  filenames_only: z.boolean().default(false),
};

export const codingWriteSchema = {
  workspace_id: z.string().min(1).max(200),
  path: z.string().min(1).max(1_000),
  content: z.string().max(1_000_000),
};

export const codingEditSchema = {
  workspace_id: z.string().min(1).max(200),
  path: z.string().min(1).max(1_000),
  target: z.string().min(1).max(1_000_000),
  replacement: z.string().max(1_000_000),
  start_line: z.number().int().min(0).max(1_000_000).default(0),
  end_line: z.number().int().min(0).max(1_000_000).default(0),
};

export const codingDirectorySchema = {
  workspace_id: z.string().min(1).max(200),
  path: z.string().min(1).max(1_000),
};

export const codingMoveSchema = {
  workspace_id: z.string().min(1).max(200),
  source: z.string().min(1).max(1_000),
  destination: z.string().min(1).max(1_000),
};

export const codingDeleteSchema = {
  workspace_id: z.string().min(1).max(200),
  path: z.string().min(1).max(1_000),
};

export const codingCommandSchema = {
  workspace_id: z.string().min(1).max(200),
  command: z.string().min(1).max(20_000),
  cwd: z.string().min(1).max(1_000).default("."),
  wait_seconds: z.number().int().min(0).max(60).default(0),
  allow_network: z.boolean().default(false),
};

export const codingCommandStatusSchema = {
  workspace_id: z.string().min(1).max(200),
  command_id: z.string().min(1).max(200),
  offset: z.number().int().min(0).max(100_000_000).default(0),
  wait_seconds: z.number().int().min(0).max(60).default(0),
};

export const codingCommandCancelSchema = {
  workspace_id: z.string().min(1).max(200),
  command_id: z.string().min(1).max(200),
};

export const sshHostsSchema = {
  workspace_id: z.string().min(1).max(200),
};

export const sshCommandSchema = {
  workspace_id: z.string().min(1).max(200),
  alias: z.string().min(1).max(128),
  command: z.string().min(1).max(20_000),
  wait_seconds: z.number().int().min(0).max(60).default(0),
};

export const sshCommandStatusSchema = {
  workspace_id: z.string().min(1).max(200),
  command_id: z.string().min(1).max(200),
  offset: z.number().int().min(0).max(100_000_000).default(0),
  wait_seconds: z.number().int().min(0).max(60).default(0),
};

export const sshCommandCancelSchema = {
  workspace_id: z.string().min(1).max(200),
  command_id: z.string().min(1).max(200),
};
