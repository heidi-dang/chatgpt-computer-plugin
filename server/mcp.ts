import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ComputerClient } from "./client/computer-client.js";
import { LiveTicketStore } from "./live-tickets.js";
import { WORKBENCH_RESOURCE_URI, createWorkbenchResource } from "./ui/workbench-resource.js";
import { z } from "zod";
import {
  approveAutonomousSchema,
  codingCommandCancelSchema,
  codingCommandSchema,
  codingCommandStatusSchema,
  codingEditSchema,
  codingListSchema,
  codingReadSchema,
  codingSearchSchema,
  codingWriteSchema,
  executeTaskSchema,
  messageSchema,
  monitorAutonomousSchema,
  monitorIdSchema,
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

function workbenchResult<T extends Record<string, unknown>>(
  value: T,
  target: { targetType: "task" | "monitor"; targetId: string },
  tickets: LiveTicketStore,
) {
  const stream = tickets.issue(target);
  return {
    ...result(value),
    _meta: {
      "cptr/live": stream,
      ui: { resourceUri: WORKBENCH_RESOURCE_URI },
    },
  };
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
  const server = new McpServer({ name: "chatgpt-computer-plugin", version: "0.1.0" });
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
    "cptr_list_workspaces",
    {
      title: "List CPTR workspaces",
      description: "Use this when the user wants to discover the CPTR workspaces they can control.",
      inputSchema: {},
      outputSchema: { workspaces: z.array(z.record(z.string(), z.unknown())) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async () => result(await client.listWorkspaces()),
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
    async ({ workspace_id }) => result(await client.getWorkspace(workspace_id)),
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
    async (input) => result(await client.listCodingFiles(input)),
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
    async (input) => result(await client.readCodingFile(input)),
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
    async (input) => result(await client.searchCodingFiles(input)),
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
    async (input) => result(await client.writeCodingFile(input)),
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
    async (input) => result(await client.editCodingFile(input)),
  );

  server.registerTool(
    "cptr_code_run_command",
    {
      title: "Run a bounded validation command in an authorized CPTR workspace",
      description:
        "Use this only when the user explicitly asks ChatGPT to run a development or validation command in the selected CPTR workspace. CPTR rejects destructive commands. Commands that might contact external services require explicit user approval through allow_network=true.",
      inputSchema: codingCommandSchema,
      outputSchema: {
        command_id: z.string(),
        status: z.string(),
        exit_code: z.number().int().nullable(),
        output: z.string(),
        next_offset: z.number().int(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      _meta: oauthToolMetadata,
    },
    async (input) => result(await client.runCodingCommand(input)),
  );

  server.registerTool(
    "cptr_code_get_command",
    {
      title: "Get direct-coding command status and output",
      description:
        "Use this to retrieve completion status and incremental output from a command previously started through direct coding.",
      inputSchema: codingCommandStatusSchema,
      outputSchema: {
        command_id: z.string(),
        status: z.string(),
        exit_code: z.number().int().nullable(),
        output: z.string(),
        next_offset: z.number().int(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async (input) => result(await client.getCodingCommand(input)),
  );

  server.registerTool(
    "cptr_code_cancel_command",
    {
      title: "Cancel a direct-coding command",
      description:
        "Use this only when the user explicitly asks ChatGPT to stop a running direct-coding command.",
      inputSchema: codingCommandCancelSchema,
      outputSchema: {
        command_id: z.string(),
        status: z.string(),
        exit_code: z.number().int().nullable(),
        output: z.string(),
        next_offset: z.number().int(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async (input) => result(await client.cancelCodingCommand(input)),
  );

  server.registerTool(
    "cptr_start_task",
    {
      title: "Start a CPTR task",
      description: "Use this when the user explicitly wants CPTR to start an engineering task in a selected workspace.",
      inputSchema: startTaskSchema,
      outputSchema: { id: z.string(), status: z.string(), workspace_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async (input) => {
      const task = await client.startTask({
        ...input,
        prompt: assignmentScopedPrompt(input.prompt),
      });
      return result(task);
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
      _meta: oauthToolMetadata,
    },
    async (input) => result(await client.executeTask(input)),
  );

  server.registerTool(
    "cptr_monitor_autonomous",
    {
      title: "Monitor a CPTR engineering goal",
      description: "Use this to create a persistent CPTR engineering monitor. The monitor continues server-side after the MCP call ends.",
      inputSchema: monitorAutonomousSchema,
      outputSchema: autonomousSummaryOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async (input) => result(await client.createAutonomous(input)),
  );

  server.registerTool(
    "cptr_render_live_terminal",
    {
      title: "Render a live CPTR terminal",
      description:
        "Render the live terminal only after a CPTR task or monitor exists. This tool provides a redacted, resumable observation surface; it does not grant shell access or additional permissions.",
      inputSchema: z.object({
        target_type: z.enum(["task", "monitor"]),
        target_id: z.string().min(1),
        presentation: z.enum(["inline", "expanded"]).optional(),
      }),
      outputSchema: {
        target_type: z.enum(["task", "monitor"]),
        target_id: z.string(),
        status: z.string(),
        title: z.string(),
        initial_summary: z.string(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: workbenchToolMetadata,
    },
    async ({ target_type, target_id }) => {
      if (target_type === "task") {
        const task = await client.getTask(target_id);
        return workbenchResult(
          {
            target_type,
            target_id,
            status: task.status,
            title: "CPTR task activity",
            initial_summary: `Task ${target_id} is ${task.status}.`,
          },
          { targetType: target_type, targetId: target_id },
          tickets,
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
    async ({ monitor_id }) => result(await client.getAutonomous(monitor_id)),
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
    async ({ monitor_id }) => result(await client.getAutonomousEvents(monitor_id)),
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
    async ({ monitor_id }) => result(await client.getAutonomousEvidence(monitor_id)),
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
      result(await client.steerAutonomous(monitor_id, content, idempotency_key)),
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
    async ({ monitor_id }) => result(await client.cancelAutonomous(monitor_id)),
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
      result(await client.approveAutonomous(monitor_id, approval_id, approved)),
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
    async ({ task_id }) => result(await client.getTask(task_id)),
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
    async ({ task_id }) => result(await client.getTaskOutput(task_id)),
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
      result(await client.sendMessage(task_id, content, idempotency_key)),
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
    async ({ task_id }) => result(await client.cancelTask(task_id)),
  );

  server.registerTool(
    "cptr_get_diff",
    {
      title: "Get a CPTR workspace diff",
      description: "Use this when the user wants to inspect the current Git diff for a CPTR workspace.",
      inputSchema: workspaceIdSchema,
      outputSchema: { diff: z.unknown().optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async ({ workspace_id }) => result(await client.getDiff(workspace_id)),
  );

  return server;
}
