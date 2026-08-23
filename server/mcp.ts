import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ComputerClient } from "./client/computer-client.js";
import {
  messageSchema,
  monitorAutonomousSchema,
  startTaskSchema,
  taskIdSchema,
  workspaceIdSchema,
} from "./schemas/tools.js";

function result<T extends Record<string, unknown>>(value: T) {
  return {
    structuredContent: value,
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

export function createMcpServer(client: ComputerClient): McpServer {
  const server = new McpServer({ name: "chatgpt-computer-plugin", version: "0.1.0" });

  server.registerTool(
    "cptr_list_workspaces",
    {
      title: "List CPTR workspaces",
      description: "Use this when the user wants to discover the CPTR workspaces they can control.",
      inputSchema: {},
      outputSchema: { workspaces: z.array(z.record(z.string(), z.unknown())) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
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
    },
    async (input) => result(await client.startTask(input)),
  );

  server.registerTool(
    "cptr_monitor_autonomous",
    {
      title: "Monitor a CPTR engineering goal",
      description: "Use this to create or manage a persistent CPTR engineering monitor: create, inspect status/events/evidence, steer, cancel, or approve a pending action.",
      inputSchema: monitorAutonomousSchema,
      outputSchema: {
        monitor_id: z.string().optional(),
        goal_id: z.string().optional(),
        status: z.string().optional(),
        scope_count: z.number().optional(),
        verified_count: z.number().optional(),
        current_scope: z.string().nullable().optional(),
        original_goal: z.string().optional(),
        acceptance_criteria: z.array(z.string()).optional(),
        approval_id: z.string().nullable().optional(),
        approval: z.record(z.string(), z.unknown()).optional(),
        scopes: z.array(z.record(z.string(), z.unknown())).optional(),
        events: z.array(z.record(z.string(), z.unknown())).optional(),
        evidence: z.array(z.record(z.string(), z.unknown())).optional(),
        task_id: z.string().optional(),
        message_id: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      if (input.action === "create" || !input.action) {
        if (!input.workspace_id || !input.goal || !input.acceptance_criteria?.length || !input.model_id) {
          throw new Error("create requires workspace_id, goal, acceptance_criteria, and model_id");
        }
      } else if (!input.monitor_id) {
        throw new Error("this monitor action requires monitor_id");
      } else if (input.action === "steer" && !input.content) {
        throw new Error("steer requires content");
      } else if (input.action === "approve" && (!input.approval_id || input.approved === undefined)) {
        throw new Error("approve requires approval_id and approved");
      }
      return result(await client.monitorAutonomous(input));
    },
  );

  server.registerTool(
    "cptr_get_task",
    {
      title: "Get CPTR task status",
      description: "Use this when the user wants the current durable status of a CPTR task by task ID.",
      inputSchema: taskIdSchema,
      outputSchema: { id: z.string(), status: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
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
    },
    async ({ task_id, content }) => result(await client.sendMessage(task_id, content)),
  );

  server.registerTool(
    "cptr_cancel_task",
    {
      title: "Cancel a CPTR task",
      description: "Use this when the user explicitly wants to stop a running CPTR task by task ID.",
      inputSchema: taskIdSchema,
      outputSchema: { id: z.string(), status: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
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
    },
    async ({ workspace_id }) => result(await client.getDiff(workspace_id)),
  );

  return server;
}
