import { z } from "zod";

export const workspaceIdSchema = { workspace_id: z.string().min(1).max(200) };

const factoryRunId = z.string().min(1).max(200);
const factoryIdempotencyKey = z.string().min(1).max(200);
export const factoryRunIdSchema = { run_id: factoryRunId };
export const factoryStartSchema = {
  workspace_id: z.string().min(1).max(200),
  mission: z.string().min(1).max(100_000),
  acceptance_criteria: z.array(z.string().min(1).max(10_000)).min(1).max(100),
  policy: z.record(z.string(), z.unknown()).default({}),
  budget: z.record(z.string(), z.unknown()).default({}),
  model_id: z.string().min(1).max(500).optional(),
  idempotency_key: factoryIdempotencyKey.optional(),
};
export const factoryPageSchema = {
  run_id: factoryRunId,
  cursor: z.string().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(100).default(50),
};
export const factoryMessageSchema = {
  run_id: factoryRunId,
  content: z.string().min(1).max(50_000),
  idempotency_key: factoryIdempotencyKey.optional(),
};
export const factoryControlSchema = {
  run_id: factoryRunId,
  idempotency_key: factoryIdempotencyKey,
};
export const factoryApprovalSchema = {
  run_id: factoryRunId,
  approval_id: z.string().min(1).max(200),
  approved: z.boolean(),
  note: z.string().max(4_000).optional(),
  idempotency_key: factoryIdempotencyKey.optional(),
};
export const factoryStopSchema = {
  run_id: factoryRunId,
  idempotency_key: factoryIdempotencyKey,
  timeout_ms: z.number().int().min(100).max(120_000).optional(),
};
const optionalWorkerTargetSchema = {
  worker_id: z.string().min(1).max(200).optional().describe(
    "Optional model-free Direct Coding Worker. When set, ChatGPT operates inside that worker's isolated Git worktree.",
  ),
};
const requiredWorkerIdSchema = { worker_id: z.string().min(1).max(200) };

export const directWorkerCreateSchema = {
  ...workspaceIdSchema,
  name: z.string().min(1).max(80),
  responsibility: z.string().max(500).default(""),
  repo_path: z.string().min(1).max(1_000).default("."),
};
export const directWorkerListSchema = { ...workspaceIdSchema };
export const directWorkerGetSchema = { ...workspaceIdSchema, ...requiredWorkerIdSchema };
export const directWorkersOverviewSchema = { ...workspaceIdSchema };
export const directWorkersIntegrateSchema = {
  ...workspaceIdSchema,
  worker_ids: z.array(z.string().min(1).max(200)).min(1).max(16),
};
export const directWorkerCloseSchema = {
  ...workspaceIdSchema,
  ...requiredWorkerIdSchema,
  discard_changes: z.boolean().default(false),
};
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
  note: z.string().max(50_000).optional(),
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
  session_name: z.string().min(1).max(160).optional().describe(
    "ChatGPT callers: use the exact current ChatGPT conversation title when the host exposes it. Otherwise use a concise prompt-derived Workbench session label; do not present that fallback as the host title.",
  ),
  workspace_id: z.string().min(1).max(200).optional(),
  resume_session_id: workbenchSessionId.optional(),
  delegation_authorization: z.literal("allow:delegate").optional().describe(
    "Pass this literal only when the current user prompt contains allow:delegate. It enables Delegated Agent tools for this prompt session only.",
  ),
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


export const listWorkspacesSchema = {
  include_unavailable: z.boolean().default(false),
};

export const codingListSchema = {
  workspace_id: z.string().min(1).max(200),
  ...optionalWorkerTargetSchema,
  path: z.string().min(1).max(1_000).default("."),
  recursive: z.boolean().default(false),
  max_entries: z.number().int().min(1).max(5000).default(500),
  cursor: z.string().optional(),
};

export const codingReadSchema = {
  workspace_id: z.string().min(1).max(200),
  ...optionalWorkerTargetSchema,
  path: z.string().min(1).max(1_000),
  start_line: z.number().int().min(0).max(1_000_000).default(0),
  end_line: z.number().int().min(0).max(1_000_000).default(0),
};

export const codingSearchSchema = {
  workspace_id: z.string().min(1).max(200),
  ...optionalWorkerTargetSchema,
  query: z.string().min(1).max(10_000),
  path: z.string().min(1).max(1_000).default("."),
  regex: z.boolean().default(false),
  case_insensitive: z.boolean().default(false),
  include: z.string().max(1_000).default(""),
  filenames_only: z.boolean().default(false),
  max_results: z.number().int().min(1).max(1000).default(100),
  context_lines: z.number().int().min(0).max(10).default(0),
};

export const fdxIntelligenceSchema = {
  workspace_id: z.string().min(1).max(200),
  ...optionalWorkerTargetSchema,
  action: z.enum([
    "status",
    "capabilities",
    "read",
    "search",
    "grep",
    "batch",
    "outline",
    "tree",
    "ls",
    "impact",
    "impact_v2",
    "why",
    "evidence_graph",
    "semantic_status",
    "semantic_references",
    "build_status",
    "build_graph",
    "diff",
    "index_status",
    "plan",
  ]).describe("Choose the FDX intelligence operation that best fits the current repository question."),
  repo_path: z.string().min(1).max(1_000).default(".").describe(
    "Workspace- or worker-relative repository root. Use this when the authorized CPTR workspace contains a nested Git repository.",
  ),
  path: z.string().min(1).max(1_000).optional(),
  paths: z.array(z.string().min(1).max(1_000)).max(20).default([]),
  query: z.string().max(10_000).optional(),
  pattern: z.string().max(10_000).optional(),
  symbol: z.string().max(2_000).optional(),
  target: z.string().max(2_000).optional(),
  mode: z.enum(["auto", "raw", "prototype", "deep"]).default("auto"),
  kind: z.string().max(120).optional(),
  direction: z.enum(["in", "out", "both"]).default("both"),
  depth: z.number().int().min(1).max(20).default(3),
  base: z.string().max(300).optional(),
  head: z.string().max(300).optional(),
  limit: z.number().int().min(1).max(20_000).optional(),
  offset: z.number().int().min(1).max(10_000_000).optional(),
  max_matches: z.number().int().min(1).max(1_000).default(50),
  max_files: z.number().int().min(1).max(100).default(20),
  limit_per_file: z.number().int().min(1).max(20_000).optional(),
  min_lines: z.number().int().min(1).max(100_000).default(1),
  context: z.number().int().min(0).max(20).default(2),
  with_deps: z.boolean().default(true),
  fixed_strings: z.boolean().default(false),
  case_sensitive: z.boolean().default(false),
  no_cache: z.boolean().default(false),
  dirs_only: z.boolean().default(false),
  all: z.boolean().default(false),
  staged: z.boolean().default(false),
  policy_overlay: z.boolean().default(false),
  lang: z.enum(["rust", "typescript", "javascript"]).default("rust"),
  intent: z.enum(["localize", "reference_complete", "rename", "impact_seed", "context"]).default("reference_complete"),
};

export const codingWriteSchema = {
  workspace_id: z.string().min(1).max(200),
  ...optionalWorkerTargetSchema,
  path: z.string().min(1).max(1_000),
  content: z.string().max(1_000_000),
  expected_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  overwrite: z.boolean().default(false),
};

export const codingEditSchema = {
  workspace_id: z.string().min(1).max(200),
  ...optionalWorkerTargetSchema,
  path: z.string().min(1).max(1_000),
  target: z.string().min(1).max(1_000_000),
  replacement: z.string().max(1_000_000),
  start_line: z.number().int().min(0).max(1_000_000).default(0),
  end_line: z.number().int().min(0).max(1_000_000).default(0),
  expected_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  replace_all: z.boolean().default(false),
};

export const codingDirectorySchema = {
  workspace_id: z.string().min(1).max(200),
  ...optionalWorkerTargetSchema,
  path: z.string().min(1).max(1_000),
};

export const codingMoveSchema = {
  workspace_id: z.string().min(1).max(200),
  ...optionalWorkerTargetSchema,
  source: z.string().min(1).max(1_000),
  destination: z.string().min(1).max(1_000),
  overwrite: z.boolean().default(false),
};

export const codingDeleteSchema = {
  workspace_id: z.string().min(1).max(200),
  ...optionalWorkerTargetSchema,
  path: z.string().min(1).max(1_000),
};

export const workspaceProjectSchema = { workspace_id: z.string().min(1).max(200), ...optionalWorkerTargetSchema };
export const workspaceTreeSchema = {
  workspace_id: z.string().min(1).max(200),
  ...optionalWorkerTargetSchema,
  path: z.string().min(1).max(1_000).default("."),
  depth: z.number().int().min(1).max(4).default(2),
};
export const workspaceMetadataSchema = {
  workspace_id: z.string().min(1).max(200),
  ...optionalWorkerTargetSchema,
  path: z.string().min(1).max(1_000),
};
export const workspaceReadManySchema = {
  workspace_id: z.string().min(1).max(200),
  ...optionalWorkerTargetSchema,
  paths: z.array(z.string().min(1).max(1_000)).min(1).max(20),
};
export const workspaceSymbolSearchSchema = {
  workspace_id: z.string().min(1).max(200),
  ...optionalWorkerTargetSchema,
  query: z.string().min(1).max(200),
  path: z.string().min(1).max(1_000).default("."),
};
export const workspaceTestDiscoverySchema = {
  workspace_id: z.string().min(1).max(200),
  ...optionalWorkerTargetSchema,
  path: z.string().min(1).max(1_000).default("."),
  depth: z.number().int().min(1).max(4).default(3),
};
export const workspaceDependencySchema = { workspace_id: z.string().min(1).max(200), ...optionalWorkerTargetSchema };
export const workspaceScriptsSchema = { workspace_id: z.string().min(1).max(200), ...optionalWorkerTargetSchema };
export const workspaceReleaseReadinessSchema = { workspace_id: z.string().min(1).max(200), ...optionalWorkerTargetSchema };
export const workspaceTestTargetSchema = {
  workspace_id: z.string().min(1).max(200),
  ...optionalWorkerTargetSchema,
  target: z.enum(["python_pytest", "node_test", "node_vitest", "node_build"]),
  path: z.string().min(1).max(1_000).default("."),
  test_path: z.string().min(1).max(1_000).optional(),
  wait_seconds: z.number().int().min(0).max(60).default(0),
  workbench_session_id: workbenchSessionId.optional(),
};

export const codingCommandSchema = {
  workspace_id: z.string().min(1).max(200),
  ...optionalWorkerTargetSchema,
  command: z.string().min(1).max(20_000),
  cwd: z.string().min(1).max(1_000).default("."),
  wait_seconds: z.number().int().min(0).max(60).default(0),
  allow_network: z.boolean().default(false),
  pty: z.boolean().default(false).describe("Run the command in a real PTY so stdin, resize, and terminal control signals are available."),
  rows: z.number().int().min(5).max(300).default(24),
  cols: z.number().int().min(20).max(500).default(80),
  stdin: z.string().max(65_536).optional().describe("Optional initial stdin sent immediately after the command session starts."),
  workbench_session_id: workbenchSessionId.optional(),
  idempotency_key: z.string().min(1).max(200).optional(),
};

export const codingCommandStatusSchema = {
  workspace_id: z.string().min(1).max(200),
  ...optionalWorkerTargetSchema,
  command_id: z.string().min(1).max(200),
  offset: z.number().int().min(0).max(100_000_000).default(0),
  wait_seconds: z.number().int().min(0).max(60).default(0),
  tail_bytes: z.number().int().min(0).max(10_000_000).optional(),
};

export const listTasksSchema = { workspace_id: z.string().optional(), status: z.string().optional(), limit: z.number().int().min(1).max(100).default(20) };
export const taskEventsSchema = { task_id: z.string().min(1), after_sequence: z.number().int().min(0).default(0), max_events: z.number().int().min(1).max(500).default(50) };
export const autonomousEventsSchema = { monitor_id: z.string().min(1), after_sequence: z.number().int().min(0).default(0), max_events: z.number().int().min(1).max(500).default(100) };
export const autonomousEvidenceSchema = { monitor_id: z.string().min(1), scope_id: z.string().optional() };
export const listAutonomousSchema = { workspace_id: z.string().optional(), status: z.string().optional(), limit: z.number().int().min(1).max(100).default(20) };
export const taskOutputSchema = { task_id: z.string().min(1).max(200), offset: z.number().int().min(0).default(0), max_chars: z.number().int().min(1).max(200_000).default(20_000) };
export const taskReviewSchema = { task_id: z.string().min(1).max(200), max_diff_bytes: z.number().int().min(1).max(2_000_000).default(100_000) };
export const gitStatusSchema = { workspace_id: z.string().min(1).max(200), ...optionalWorkerTargetSchema };
export const gitDiffSchema = { workspace_id: z.string().min(1).max(200), ...optionalWorkerTargetSchema, paths: z.array(z.string().min(1).max(1_000)).max(100).optional(), max_bytes: z.number().int().min(1).max(2_000_000).default(100_000) };
export const readManyFilesSchema = { workspace_id: z.string().min(1), ...optionalWorkerTargetSchema, files: z.array(z.object({ path: z.string().min(1), start_line: z.number().int().min(0).optional(), end_line: z.number().int().min(0).optional() })).min(1).max(10), max_chars: z.number().int().min(1).max(200000).default(20000) };
export const applyEditsSchema = { workspace_id: z.string().min(1), ...optionalWorkerTargetSchema, path: z.string().min(1), edits: z.array(z.object({ target: z.string().min(1), replacement: z.string() })).min(1).max(20), expected_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() };

export const codingCommandCancelSchema = {
  workspace_id: z.string().min(1).max(200),
  ...optionalWorkerTargetSchema,
  command_id: z.string().min(1).max(200),
};

export const codingCommandInputSchema = {
  workspace_id: z.string().min(1).max(200),
  ...optionalWorkerTargetSchema,
  command_id: z.string().min(1).max(200),
  data: z.string().max(65_536),
};

export const codingCommandResizeSchema = {
  workspace_id: z.string().min(1).max(200),
  ...optionalWorkerTargetSchema,
  command_id: z.string().min(1).max(200),
  rows: z.number().int().min(5).max(300),
  cols: z.number().int().min(20).max(500),
};

export const codingCommandSignalSchema = {
  workspace_id: z.string().min(1).max(200),
  ...optionalWorkerTargetSchema,
  command_id: z.string().min(1).max(200),
  signal: z.enum(["interrupt", "terminate", "kill"]),
};

export const lspDiscoverSchema = {
  workspace_id: z.string().min(1).max(200),
  ...optionalWorkerTargetSchema,
};

export const lspStartSchema = {
  workspace_id: z.string().min(1).max(200),
  ...optionalWorkerTargetSchema,
  server_id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  root: z.string().min(1).max(1_000).default("."),
};

export const lspRequestSchema = {
  workspace_id: z.string().min(1).max(200),
  ...optionalWorkerTargetSchema,
  lsp_id: z.string().min(1).max(80),
  method: z.string().min(1).max(256),
  params: z.unknown().optional(),
  timeout_seconds: z.number().min(0.1).max(60).default(15),
};

export const lspStopSchema = {
  workspace_id: z.string().min(1).max(200),
  ...optionalWorkerTargetSchema,
  lsp_id: z.string().min(1).max(80),
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

const benchmarkRunId = z.string().regex(/^bench_[A-Za-z0-9_-]{8,80}$/);
export const benchmarkStartSchema = {
  suite_id: z.string().min(1).max(80).default("cptr-python-core"),
};
export const benchmarkRunSchema = { run_id: benchmarkRunId };
export const benchmarkLeaderboardSchema = {
  suite_id: z.string().min(1).max(80).default("cptr-python-core"),
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
