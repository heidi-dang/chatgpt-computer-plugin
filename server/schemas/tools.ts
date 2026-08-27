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

const workbenchSessionId = z.string().regex(/^wbs_[A-Za-z0-9_-]{16,80}$/);

export const openWorkbenchSessionSchema = {
  session_name: z.string().min(1).max(160).optional(),
  workspace_id: z.string().min(1).max(200).optional(),
  resume_session_id: workbenchSessionId.optional(),
};

export const workbenchSessionIdSchema = { workbench_session_id: workbenchSessionId };
export const workbenchSessionListSchema = {
  include_archived: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(50),
};
export const workbenchSessionEventsSchema = {
  workbench_session_id: workbenchSessionId,
  after_sequence: z.number().int().min(0).max(100_000_000).default(0),
  limit: z.number().int().min(1).max(200).default(100),
};
export const workbenchSessionBindSchema = {
  workbench_session_id: workbenchSessionId,
  target_type: z.enum(["task", "monitor", "command"]),
  target_id: z.string().min(1).max(200),
  workspace_id: z.string().min(1).max(200).optional(),
};
export const workbenchSessionRenameSchema = {
  workbench_session_id: workbenchSessionId,
  name: z.string().min(1).max(160),
};
export const workbenchSessionDeleteRequestSchema = { workbench_session_id: workbenchSessionId };
export const workbenchSessionDeleteConfirmSchema = {
  confirmation_id: z.string().min(1).max(200),
};

export const startTaskSchema = {
  workspace_id: z.string().min(1).max(200),
  prompt: z.string().min(1).max(100_000),
  model_id: z.string().min(1).max(500).optional(),
  idempotency_key: z.string().min(1).max(200).optional(),
  execution_policy: taskExecutionPolicySchema,
  workbench_session_id: workbenchSessionId.optional(),
};

export const executeTaskSchema = {
  workspace_id: z.string().min(1).max(200),
  prompt: z.string().min(1).max(100_000),
  model_id: z.string().min(1).max(500).optional(),
  wait_seconds: z.number().int().min(1).max(60).default(30),
  idempotency_key: z.string().min(1).max(200).optional(),
  execution_policy: taskExecutionPolicySchema,
  workbench_session_id: workbenchSessionId.optional(),
};

export const monitorAutonomousSchema = {
  workspace_id: z.string().min(1).max(200),
  goal: z.string().min(1).max(100_000),
  acceptance_criteria: z.array(z.string().min(1).max(10_000)).min(1).max(100),
  model_id: z.string().min(1).max(500).optional(),
  idempotency_key: z.string().min(1).max(200).optional(),
  execution_policy: taskExecutionPolicySchema,
  workbench_session_id: workbenchSessionId.optional(),
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

export const workspaceProjectSchema = { workspace_id: z.string().min(1).max(200) };
export const workspaceTreeSchema = {
  workspace_id: z.string().min(1).max(200),
  path: z.string().min(1).max(1_000).default("."),
  depth: z.number().int().min(1).max(4).default(2),
};
export const workspaceMetadataSchema = {
  workspace_id: z.string().min(1).max(200),
  path: z.string().min(1).max(1_000),
};
export const workspaceReadManySchema = {
  workspace_id: z.string().min(1).max(200),
  paths: z.array(z.string().min(1).max(1_000)).min(1).max(20),
};
export const workspaceSymbolSearchSchema = {
  workspace_id: z.string().min(1).max(200),
  query: z.string().min(1).max(200),
  path: z.string().min(1).max(1_000).default("."),
};
export const workspaceTestDiscoverySchema = {
  workspace_id: z.string().min(1).max(200),
  path: z.string().min(1).max(1_000).default("."),
  depth: z.number().int().min(1).max(4).default(3),
};
export const workspaceDependencySchema = { workspace_id: z.string().min(1).max(200) };
export const workspaceScriptsSchema = { workspace_id: z.string().min(1).max(200) };
export const workspaceReleaseReadinessSchema = { workspace_id: z.string().min(1).max(200) };
export const workspaceTestTargetSchema = {
  workspace_id: z.string().min(1).max(200),
  target: z.enum(["python_pytest", "node_test", "node_vitest", "node_build"]),
  path: z.string().min(1).max(1_000).default("."),
  test_path: z.string().min(1).max(1_000).optional(),
  wait_seconds: z.number().int().min(0).max(60).default(0),
  workbench_session_id: workbenchSessionId.optional(),
};

export const codingCommandSchema = {
  workspace_id: z.string().min(1).max(200),
  command: z.string().min(1).max(20_000),
  cwd: z.string().min(1).max(1_000).default("."),
  wait_seconds: z.number().int().min(0).max(60).default(0),
  allow_network: z.boolean().default(false),
  workbench_session_id: workbenchSessionId.optional(),
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

export const pluginUpdateSchema = {
  action: z.enum(["status", "release_notes", "verify_server"]),
  expected_contract_version: z.string().min(1).max(64).optional(),
  expected_tool_count: z.number().int().min(1).max(500).optional(),
};

export const chromeBrowserSchema = {
  workspace_id: z.string().min(1).max(200),
  action: z.enum([
    "status",
    "navigate",
    "snapshot",
    "click",
    "type",
    "press_key",
    "scroll",
    "screenshot",
    "close",
  ]),
  url: z.string().max(4_096).optional(),
  ref: z.string().max(64).optional(),
  text: z.string().max(20_000).optional(),
  key: z.string().max(128).optional(),
  modifiers: z.array(z.enum(["Alt", "Control", "Meta", "Shift"])).max(4).default([]),
  direction: z.enum(["up", "down"]).default("down"),
  amount: z.number().int().min(1).max(20).default(3),
  width: z.number().int().min(320).max(3_840).optional(),
  height: z.number().int().min(240).max(2_160).optional(),
  allow_network: z.boolean().default(false),
};
