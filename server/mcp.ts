import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ComputerClient } from "./client/computer-client.js";
import { LiveTicketStore } from "./live-tickets.js";
import { WORKBENCH_RESOURCE_URI, createWorkbenchResource } from "./ui/workbench-resource.js";
import { z } from "zod";
import {
  approveAutonomousSchema,
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
      const task = await client.startTask(input);
      return workbenchResult(task, { targetType: "task", targetId: task.id }, tickets);
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
      return workbenchResult(monitor, {
        targetType: "monitor",
        targetId: String(monitor.monitor_id),
      }, tickets);
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
