import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ComputerClient } from "./client/computer-client.js";
import { LiveTicketStore, type LiveTarget } from "./live-tickets.js";
import { WORKBENCH_RESOURCE_URI, createWorkbenchResource } from "./ui/workbench-resource.js";
import { z } from "zod";
export const MCP_CONTRACT_VERSION = "0.3.0";
export const MCP_CONTRACT_TOOL_COUNT = 32;

import {
  approveAutonomousSchema,
  codingCommandCancelSchema,
  codingCommandSchema,
  codingCommandStatusSchema,
  codingDeleteSchema,
  codingDirectorySchema,
  codingEditSchema,
  codingListSchema,
  codingMoveSchema,
  codingReadSchema,
  codingSearchSchema,
  codingWriteSchema,
  executeTaskSchema,
  messageSchema,
  monitorAutonomousSchema,
  monitorIdSchema,
  reviewDecisionSchema,
  startTaskSchema,
  steerAutonomousSchema,
  taskIdSchema,
  workspaceIdSchema,
} from "./schemas/tools.js";

function result<T extends Record<string, unknown>>(value: T) {
  return {
    structuredContent: value,
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

const DIRECT_TASK_SCOPE_PREFIX =
  "CPTR control-task safety contract: inspection_scope=assignment. " +
  "Only inspect or mutate files explicitly named by this assignment or created during this task. " +
  "Do not list, search, or inspect unrelated historical fixture files. " +
  "Use only bounded pathless waits or commands against explicitly assigned paths.";

function assignmentScopedPrompt(prompt: string): string {
  const value = prompt.trim();
  if (value.includes("inspection_scope=assignment")) return value;
  return `${DIRECT_TASK_SCOPE_PREFIX}\n\nAssignment:\n${value}`;
}

function mcpActivity(toolName: string, summary: string, status = "COMPLETE") {
  return {
    event_id: `mcp-${crypto.randomUUID()}`,
    timestamp: new Date().toISOString(),
    type: "mcp.tool",
    payload: { tool_name: toolName, summary, status },
  };
}

function workbenchResult<T extends Record<string, unknown>>(
  value: T,
  target: LiveTarget,
  tickets: LiveTicketStore,
  toolName = "cptr_render_live_terminal",
) {
  const stream = tickets.issue(target);
  const workspaceId = typeof value.workspace_id === "string" ? value.workspace_id : undefined;
  return {
    ...result(value),
    _meta: {
      "cptr/live": { ...stream, ...(workspaceId ? { workspaceId } : {}) },
      "cptr/activity": mcpActivity(toolName, `ChatGPT called ${toolName}; live CPTR activity is attached.`),
      ui: { resourceUri: WORKBENCH_RESOURCE_URI },
    },
  };
}

function activityResult<T extends Record<string, unknown>>(value: T, toolName: string, summary?: string) {
  return {
    ...result(value),
    _meta: {
      "cptr/activity": mcpActivity(toolName, summary ?? `ChatGPT completed ${toolName}.`),
      ui: { resourceUri: WORKBENCH_RESOURCE_URI },
    },
  };
}

function initialWorkbenchResult<T extends Record<string, unknown>>(value: T, toolName: string) {
  return activityResult(
    value,
    toolName,
    "CPTR Live Workbench is ready; waiting for ChatGPT to select a workspace or start a task.",
  );
}

const oauthToolMetadata = {
  securitySchemes: [{ type: "oauth2", scopes: [] }],
};

const workbenchToolMetadata = {
  ...oauthToolMetadata,
  ui: { resourceUri: WORKBENCH_RESOURCE_URI },
};

const autonomousSummaryOutputSchema = {
  monitor_id: z.string().optional(),
  goal_id: z.string().optional(),
  workspace_id: z.string().optional(),
  status: z.string().optional(),
  scope_count: z.number().optional(),
  verified_count: z.number().optional(),
  current_scope: z.string().nullable().optional(),
  original_goal: z.string().optional(),
  acceptance_criteria: z.array(z.string()).optional(),
  approval_id: z.string().nullable().optional(),
  approval: z.record(z.string(), z.unknown()).optional(),
  scopes: z.array(z.record(z.string(), z.unknown())).optional(),
};

export function createMcpServer(
  client: ComputerClient,
  options: { tickets?: LiveTicketStore; widgetBundle?: string; widgetStyles?: string; connectDomain?: string } = {},
): McpServer {
  const server = new McpServer({ name: "chatgpt-computer-plugin", version: "0.3.0" });
  const tickets = options.tickets ?? new LiveTicketStore();
  server.registerResource(
    "cptr-live-workbench",
    WORKBENCH_RESOURCE_URI,
    {},
    async () => createWorkbenchResource(
      options.widgetBundle ?? "document.body.textContent = 'CPTR Live Workbench';",
      options.connectDomain,
      options.widgetStyles,
    ),
  );

  server.registerTool(
    "cptr_open_live_workbench",
    {
      title: "Open the CPTR Live Workbench",
      description:
        "Call this first whenever the user explicitly invokes @cptr computer or asks CPTR to work. It immediately opens the CPTR terminal in ChatGPT; later task-start or monitor calls bind the same terminal to the live, redacted CPTR event stream.",
      inputSchema: {},
      outputSchema: { status: z.string(), title: z.string(), initial_summary: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: workbenchToolMetadata,
    },
    async () => initialWorkbenchResult(
      {
        status: "READY",
        title: "CPTR computer activity",
        initial_summary: "Live Workbench is ready. Select a workspace or start a CPTR task to attach the live terminal.",
      },
      "cptr_open_live_workbench",
    ),
  );

  server.registerTool(
    "cptr_list_workspaces",
    {
      title: "List CPTR workspaces",
      description: "Use this when the user wants to discover the CPTR workspaces they can control.",
      inputSchema: {},
      outputSchema: { workspaces: z.array(z.record(z.string(), z.unknown())) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: workbenchToolMetadata,
    },
    async () => initialWorkbenchResult(await client.listWorkspaces(), "cptr_list_workspaces"),
  );

  server.registerTool(
    "cptr_get_workspace",
    {
      title: "Get a CPTR workspace",
      description: "Use this when the user wants details about one CPTR workspace by workspace ID.",
      inputSchema: workspaceIdSchema,
      outputSchema: { workspace_id: z.string(), name: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async ({ workspace_id }) => activityResult(await client.getWorkspace(workspace_id), "cptr_get_workspace"),
  );

  server.registerTool(
    "cptr_code_list_files",
    {
      title: "List files in an authorized CPTR workspace",
      description:
        "Use this to inspect the selected CPTR workspace before ChatGPT directly edits code. It cannot access paths outside that workspace.",
      inputSchema: codingListSchema,
      outputSchema: { workspace_id: z.string(), path: z.string(), entries: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async (input) => activityResult(await client.listCodingFiles(input), "cptr_code_list_files"),
  );

  server.registerTool(
    "cptr_code_read_file",
    {
      title: "Read an authorized CPTR workspace file",
      description:
        "Use this to read source code in the selected CPTR workspace before ChatGPT edits it. Environment files, binary files, paths outside the workspace, and oversized files are rejected by CPTR.",
      inputSchema: codingReadSchema,
      outputSchema: {
        workspace_id: z.string(),
        path: z.string(),
        content: z.string(),
        start_line: z.number().int(),
        end_line: z.number().int(),
        total_lines: z.number().int(),
        size: z.number().int(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async (input) => activityResult(await client.readCodingFile(input), "cptr_code_read_file"),
  );

  server.registerTool(
    "cptr_code_search_files",
    {
      title: "Search an authorized CPTR workspace",
      description:
        "Use this to locate symbols, text, or files in the selected CPTR workspace before ChatGPT edits code.",
      inputSchema: codingSearchSchema,
      outputSchema: { workspace_id: z.string(), path: z.string(), matches: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async (input) => activityResult(await client.searchCodingFiles(input), "cptr_code_search_files"),
  );

  server.registerTool(
    "cptr_code_write_file",
    {
      title: "Write a file in an authorized CPTR workspace",
      description:
        "Use this only when the user explicitly asks ChatGPT to create or replace code in the selected CPTR workspace. Read the existing file first when modifying it. CPTR rejects paths outside the workspace and environment files.",
      inputSchema: codingWriteSchema,
      outputSchema: { workspace_id: z.string(), path: z.string(), bytes_written: z.number().int() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async (input) => activityResult(await client.writeCodingFile(input), "cptr_code_write_file"),
  );

  server.registerTool(
    "cptr_code_edit_file",
    {
      title: "Apply an exact code edit in an authorized CPTR workspace",
      description:
        "Use this only when the user explicitly asks ChatGPT to modify code. It replaces an exact, unique target string and refuses ambiguous edits, so read the file first and then provide the precise target.",
      inputSchema: codingEditSchema,
      outputSchema: {
        workspace_id: z.string(),
        path: z.string(),
        replaced_characters: z.number().int(),
        inserted_characters: z.number().int(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async (input) => activityResult(await client.editCodingFile(input), "cptr_code_edit_file"),
  );

  server.registerTool(
    "cptr_code_create_directory",
    {
      title: "Create a directory in an authorized CPTR workspace",
      description:
        "Use this only when the user explicitly asks ChatGPT to create a source directory in the selected CPTR workspace. Paths remain confined to the workspace.",
      inputSchema: codingDirectorySchema,
      outputSchema: { workspace_id: z.string(), path: z.string(), type: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async (input) => activityResult(await client.createCodingDirectory(input), "cptr_code_create_directory"),
  );

  server.registerTool(
    "cptr_code_move_file",
    {
      title: "Move a file in an authorized CPTR workspace",
      description:
        "Use this only when the user explicitly asks ChatGPT to rename or move a file. CPTR confines both paths to the selected workspace, refuses directory moves, and refuses overwriting an existing destination.",
      inputSchema: codingMoveSchema,
      outputSchema: { workspace_id: z.string(), source: z.string(), destination: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async (input) => activityResult(await client.moveCodingFile(input), "cptr_code_move_file"),
  );

  server.registerTool(
    "cptr_code_delete_file",
    {
      title: "Delete a file in an authorized CPTR workspace",
      description:
        "Use this only when the user explicitly asks ChatGPT to delete a file. CPTR confines the path to the selected workspace and refuses directory deletion.",
      inputSchema: codingDeleteSchema,
      outputSchema: { workspace_id: z.string(), path: z.string(), deleted: z.boolean() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async (input) => activityResult(await client.deleteCodingFile(input), "cptr_code_delete_file"),
  );

  server.registerTool(
    "cptr_code_get_git_status",
    {
      title: "Get Git status for an authorized CPTR workspace",
      description:
        "Use this to inspect changed, staged, and untracked files in the selected CPTR workspace before or after direct coding edits.",
      inputSchema: workspaceIdSchema,
      outputSchema: { is_repo: z.boolean(), files: z.array(z.record(z.string(), z.unknown())) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async ({ workspace_id }) => activityResult(await client.getGitStatus(workspace_id), "cptr_code_get_git_status"),
  );

  server.registerTool(
    "cptr_code_run_command",
    {
      title: "Run a bounded validation command in an authorized CPTR workspace",
      description:
        "Use this only when the user explicitly asks ChatGPT to run a development or validation command in the selected CPTR workspace. CPTR rejects destructive commands. Commands that might contact external services require explicit user approval through allow_network=true.",
      inputSchema: codingCommandSchema,
      outputSchema: {
        workspace_id: z.string(),
        command_id: z.string(),
        status: z.string(),
        exit_code: z.number().int().nullable(),
        output: z.string(),
        next_offset: z.number().int(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      _meta: workbenchToolMetadata,
    },
    async (input) => {
      const command = await client.runCodingCommand(input);
      return workbenchResult(
        { ...command, workspace_id: input.workspace_id },
        { targetType: "command", targetId: command.command_id, workspaceId: input.workspace_id },
        tickets,
        "cptr_code_run_command",
      );
    },
  );

  server.registerTool(
    "cptr_code_get_command",
    {
      title: "Get direct-coding command status and output",
      description:
        "Use this to retrieve completion status and incremental output from a command previously started through direct coding.",
      inputSchema: codingCommandStatusSchema,
      outputSchema: {
        workspace_id: z.string(),
        command_id: z.string(),
        status: z.string(),
        exit_code: z.number().int().nullable(),
        output: z.string(),
        next_offset: z.number().int(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: workbenchToolMetadata,
    },
    async (input) => {
      const command = await client.getCodingCommand(input);
      return workbenchResult(
        { ...command, workspace_id: input.workspace_id },
        { targetType: "command", targetId: input.command_id, workspaceId: input.workspace_id },
        tickets,
        "cptr_code_get_command",
      );
    },
  );

  server.registerTool(
    "cptr_code_cancel_command",
    {
      title: "Cancel a direct-coding command",
      description:
        "Use this only when the user explicitly asks ChatGPT to stop a running direct-coding command.",
      inputSchema: codingCommandCancelSchema,
      outputSchema: {
        workspace_id: z.string(),
        command_id: z.string(),
        status: z.string(),
        exit_code: z.number().int().nullable(),
        output: z.string(),
        next_offset: z.number().int(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      _meta: workbenchToolMetadata,
    },
    async (input) => {
      const command = await client.cancelCodingCommand(input);
      return workbenchResult(
        { ...command, workspace_id: input.workspace_id },
        { targetType: "command", targetId: input.command_id, workspaceId: input.workspace_id },
        tickets,
        "cptr_code_cancel_command",
      );
    },
  );

  server.registerTool(
    "cptr_start_task",
    {
      title: "Start a CPTR task",
      description: "Use this when the user explicitly wants CPTR to start an engineering task in a selected workspace.",
      inputSchema: startTaskSchema,
      outputSchema: { id: z.string(), status: z.string(), workspace_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: workbenchToolMetadata,
    },
    async (input) => {
      const task = await client.startTask({
        ...input,
        prompt: assignmentScopedPrompt(input.prompt),
      });
      return workbenchResult(
        task,
        { targetType: "task", targetId: task.id },
        tickets,
        "cptr_start_task",
      );
    },
  );

  server.registerTool(
    "cptr_execute_task",
    {
      title: "Execute a CPTR task now",
      description:
        "Use this only when the user explicitly asks ChatGPT to execute a contained task in a selected CPTR workspace. It starts an authorized CPTR task and waits up to 60 seconds for a result. If it remains active, return the task ID and use task-status tools rather than retrying. This tool does not grant additional CPTR permissions; CPTR authorization and approval policy remain authoritative.",
      inputSchema: executeTaskSchema,
      outputSchema: {
        task_id: z.string(),
        workspace_id: z.string(),
        status: z.string(),
        output: z.string(),
        output_truncated: z.boolean(),
        error: z.string().nullable().optional(),
        completed: z.boolean(),
        wait_seconds: z.number().int(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      _meta: workbenchToolMetadata,
    },
    async (input) => {
      const task = await client.executeTask({
        ...input,
        prompt: assignmentScopedPrompt(input.prompt),
      });
      return workbenchResult(
        task,
        { targetType: "task", targetId: task.task_id },
        tickets,
        "cptr_execute_task",
      );
    },
  );

  server.registerTool(
    "cptr_monitor_autonomous",
    {
      title: "Monitor a CPTR engineering goal",
      description: "Use this to create a persistent CPTR engineering monitor. The monitor continues server-side after the MCP call ends.",
      inputSchema: monitorAutonomousSchema,
      outputSchema: autonomousSummaryOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: workbenchToolMetadata,
    },
    async (input) => {
      const monitor = await client.createAutonomous(input);
      const monitorId = String(monitor.monitor_id ?? monitor.goal_id ?? "");
      if (!monitorId) return activityResult(monitor, "cptr_monitor_autonomous");
      return workbenchResult(
        monitor,
        { targetType: "monitor", targetId: monitorId },
        tickets,
        "cptr_monitor_autonomous",
      );
    },
  );

  server.registerTool(
    "cptr_render_live_terminal",
    {
      title: "Render a live CPTR terminal",
      description:
        "Render the live terminal after a CPTR task, monitor, or workspace-owned direct command exists. This tool provides a redacted, resumable observation surface; it does not grant shell access or additional permissions.",
      inputSchema: z.object({
        target_type: z.enum(["task", "monitor", "command"]),
        target_id: z.string().min(1),
        workspace_id: z.string().min(1).max(200).optional(),
        presentation: z.enum(["inline", "expanded"]).optional(),
      }),
      outputSchema: {
        target_type: z.enum(["task", "monitor", "command"]),
        target_id: z.string(),
        status: z.string(),
        workspace_id: z.string().optional(),
        review_status: z.string().optional(),
        title: z.string(),
        initial_summary: z.string(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: workbenchToolMetadata,
    },
    async ({ target_type, target_id, workspace_id }) => {
      if (target_type === "task") {
        const task = await client.getTask(target_id);
        return workbenchResult(
          {
            target_type,
            target_id,
            status: task.status,
            workspace_id: task.workspace_id,
            review_status: task.review?.status,
            title: "CPTR task activity",
            initial_summary: `Task ${target_id} is ${task.status}.`,
          },
          { targetType: target_type, targetId: target_id },
          tickets,
          "cptr_render_live_terminal",
        );
      }
      if (target_type === "command") {
        if (!workspace_id) throw new Error("workspace_id is required for a command live terminal");
        const command = await client.getCodingCommand({
          workspace_id,
          command_id: target_id,
          offset: 0,
          wait_seconds: 0,
        });
        return workbenchResult(
          {
            target_type,
            target_id,
            status: command.status,
            workspace_id,
            title: "CPTR command activity",
            initial_summary: `Command ${target_id} is ${command.status}.`,
          },
          { targetType: "command", targetId: target_id, workspaceId: workspace_id },
          tickets,
          "cptr_render_live_terminal",
        );
      }
      const monitor = await client.getAutonomous(target_id);
      const status = String(monitor.status ?? "UNKNOWN");
      return workbenchResult(
        {
          target_type,
          target_id,
          status,
          title: "CPTR autonomous monitor",
          initial_summary: `Monitor ${target_id} is ${status}.`,
        },
        { targetType: target_type, targetId: target_id },
        tickets,
        "cptr_render_live_terminal",
      );
    },
  );

  server.registerTool(
    "cptr_get_autonomous",
    {
      title: "Get a CPTR autonomous monitor",
      description: "Use this to inspect the durable status of a CPTR autonomous monitor.",
      inputSchema: monitorIdSchema,
      outputSchema: autonomousSummaryOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async ({ monitor_id }) => activityResult(await client.getAutonomous(monitor_id), "cptr_get_autonomous"),
  );

  server.registerTool(
    "cptr_get_autonomous_events",
    {
      title: "Get CPTR autonomous events",
      description: "Use this to inspect durable lifecycle events for a CPTR autonomous monitor.",
      inputSchema: monitorIdSchema,
      outputSchema: {
        monitor_id: z.string().optional(),
        events: z.array(z.record(z.string(), z.unknown())).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async ({ monitor_id }) => activityResult(await client.getAutonomousEvents(monitor_id), "cptr_get_autonomous_events"),
  );

  server.registerTool(
    "cptr_get_autonomous_evidence",
    {
      title: "Get CPTR autonomous evidence",
      description: "Use this to inspect persisted worker and independent verification evidence for a CPTR autonomous monitor.",
      inputSchema: monitorIdSchema,
      outputSchema: {
        monitor_id: z.string().optional(),
        evidence: z.array(z.record(z.string(), z.unknown())).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async ({ monitor_id }) => activityResult(await client.getAutonomousEvidence(monitor_id), "cptr_get_autonomous_evidence"),
  );

  server.registerTool(
    "cptr_steer_autonomous",
    {
      title: "Steer a CPTR autonomous monitor",
      description: "Use this to send a scoped follow-up message to a running CPTR autonomous monitor.",
      inputSchema: steerAutonomousSchema,
      outputSchema: {
        task_id: z.string().optional(),
        message_id: z.string().optional(),
        status: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async ({ monitor_id, content, idempotency_key }) =>
      activityResult(await client.steerAutonomous(monitor_id, content, idempotency_key), "cptr_steer_autonomous"),
  );

  server.registerTool(
    "cptr_cancel_autonomous",
    {
      title: "Cancel a CPTR autonomous monitor",
      description: "Use this when the user explicitly wants to stop a running CPTR autonomous monitor.",
      inputSchema: monitorIdSchema,
      outputSchema: autonomousSummaryOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async ({ monitor_id }) => activityResult(await client.cancelAutonomous(monitor_id), "cptr_cancel_autonomous"),
  );

  server.registerTool(
    "cptr_approve_autonomous",
    {
      title: "Approve a CPTR autonomous action",
      description: "Use this only when the user explicitly approves a pending CPTR action. Approval may release an external or destructive operation, so CPTR policy remains authoritative.",
      inputSchema: approveAutonomousSchema,
      outputSchema: autonomousSummaryOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      _meta: oauthToolMetadata,
    },
    async ({ monitor_id, approval_id, approved }) =>
      activityResult(await client.approveAutonomous(monitor_id, approval_id, approved), "cptr_approve_autonomous"),
  );

  server.registerTool(
    "cptr_get_task",
    {
      title: "Get CPTR task status",
      description: "Use this when the user wants the current durable status of a CPTR task by task ID.",
      inputSchema: taskIdSchema,
      outputSchema: { id: z.string(), status: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async ({ task_id }) => activityResult(await client.getTask(task_id), "cptr_get_task"),
  );

  server.registerTool(
    "cptr_get_task_output",
    {
      title: "Get CPTR task output",
      description: "Use this when the user wants durable output from a CPTR task by task ID.",
      inputSchema: taskIdSchema,
      outputSchema: { task_id: z.string(), status: z.string(), content: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async ({ task_id }) => activityResult(await client.getTaskOutput(task_id), "cptr_get_task_output"),
  );

  server.registerTool(
    "cptr_get_task_review",
    {
      title: "Get a CPTR task review",
      description:
        "Use this to retrieve the durable review state and authorized workspace diff for one CPTR task. The diff is task-bound and must be shown before asking the user for a decision.",
      inputSchema: taskIdSchema,
      outputSchema: {
        task_id: z.string(),
        workspace_id: z.string(),
        status: z.string(),
        review: z.record(z.string(), z.unknown()),
        diff: z.record(z.string(), z.unknown()),
        review_available: z.boolean(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async ({ task_id }) => activityResult(await client.getTaskReview(task_id), "cptr_get_task_review"),
  );

  server.registerTool(
    "cptr_decide_task_review",
    {
      title: "Decide a CPTR task review",
      description:
        "Use this only after the user explicitly accepts, rejects, or requests changes to a CPTR task that is awaiting diff review. Acceptance and rejection are durable user decisions; request changes queues a scoped follow-up.",
      inputSchema: reviewDecisionSchema,
      outputSchema: {
        id: z.string(),
        status: z.string(),
        review: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async ({ task_id, decision, note, idempotency_key }) =>
      activityResult(await client.decideTaskReview(task_id, { decision, note, idempotency_key }), "cptr_decide_task_review"),
  );

  server.registerTool(
    "cptr_send_message",
    {
      title: "Send a message to CPTR",
      description: "Use this when the user explicitly wants to steer an existing CPTR task with a follow-up message.",
      inputSchema: messageSchema,
      outputSchema: { task_id: z.string(), message_id: z.string(), status: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async ({ task_id, content, idempotency_key }) =>
      activityResult(await client.sendMessage(task_id, content, idempotency_key), "cptr_send_message"),
  );

  server.registerTool(
    "cptr_cancel_task",
    {
      title: "Cancel a CPTR task",
      description: "Use this when the user explicitly wants to stop a running CPTR task by task ID.",
      inputSchema: taskIdSchema,
      outputSchema: { id: z.string(), status: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async ({ task_id }) => activityResult(await client.cancelTask(task_id), "cptr_cancel_task"),
  );

  server.registerTool(
    "cptr_get_diff",
    {
      title: "Get a CPTR workspace diff",
      description: "Use this when the user wants to inspect the current Git diff for a CPTR workspace.",
      inputSchema: workspaceIdSchema,
      outputSchema: {
        is_repo: z.boolean(),
        files: z.array(z.record(z.string(), z.unknown())),
        error: z.string().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async ({ workspace_id }) => activityResult(await client.getDiff(workspace_id), "cptr_get_diff"),
  );

  return server;
}
