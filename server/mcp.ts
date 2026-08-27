import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ComputerClient } from "./client/computer-client.js";
import { LiveTicketStore, type LiveTarget } from "./live-tickets.js";
import { PromptTerminalStore } from "./prompt-terminal.js";
import { WORKBENCH_RESOURCE_URI, createWorkbenchResource } from "./ui/workbench-resource.js";
import { z } from "zod";
import {
  MCP_CONTRACT_TOOL_COUNT,
  MCP_CONTRACT_VERSION,
  currentPluginUpdateManifest,
} from "./release.js";
export { MCP_CONTRACT_TOOL_COUNT, MCP_CONTRACT_VERSION } from "./release.js";

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
  chromeBrowserSchema,
  executeTaskSchema,
  messageSchema,
  monitorAutonomousSchema,
  monitorIdSchema,
  pluginUpdateSchema,
  reviewDecisionSchema,
  startTaskSchema,
  steerAutonomousSchema,
  sshCommandCancelSchema,
  sshCommandSchema,
  sshCommandStatusSchema,
  sshHostsSchema,
  taskIdSchema,
  workspaceIdSchema,
  openWorkbenchSessionSchema,
  workbenchSessionIdSchema,
  workbenchSessionListSchema,
  workbenchSessionEventsSchema,
  workbenchSessionBindSchema,
  workbenchSessionRenameSchema,
  workbenchSessionDeleteRequestSchema,
  workbenchSessionDeleteConfirmSchema,
  workspaceDependencySchema,
  workspaceMetadataSchema,
  workspaceProjectSchema,
  workspaceReadManySchema,
  workspaceReleaseReadinessSchema,
  workspaceScriptsSchema,
  workspaceSymbolSearchSchema,
  workspaceTestDiscoverySchema,
  workspaceTestTargetSchema,
  workspaceTreeSchema,
} from "./schemas/tools.js";

function result<T extends Record<string, unknown>>(value: T) {
  return {
    structuredContent: value,
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  };
}

const DIRECT_TASK_SCOPE_PREFIX =
  "CPTR control-task safety contract: inspection_scope=workspace. " +
  "Work only inside the selected CPTR workspace. Do not inspect, modify, or verify other workspaces " +
  "unless the user's assignment explicitly requires cross-workspace work.";

function workspaceScopedPrompt(prompt: string): string {
  const value = prompt.trim();
  if (value.includes("inspection_scope=assignment") || value.includes("inspection_scope=workspace")) {
    return value;
  }
  return `${DIRECT_TASK_SCOPE_PREFIX}\n\nAssignment:\n${value}`;
}

const TERMINAL_JSON_LIMIT = 12_000;
const SENSITIVE_TERMINAL_KEY = /(?:authorization|token|secret|password|passwd|credential|cookie|api[_-]?key|access[_-]?key|identityfile)/i;

function redactTerminalString(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/g, "sk-[REDACTED]");
}

function sanitizeTerminalValue(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (depth > 6) return "[MAX_DEPTH]";
  if (typeof value === "string") return redactTerminalString(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (typeof value === "bigint") return value.toString();
  if (value === undefined) return "[UNDEFINED]";
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeTerminalValue(item, seen, depth + 1));
  }
  if (typeof value === "object") {
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    if (value instanceof Error) {
      return { name: value.name, message: redactTerminalString(value.message) };
    }
    const sanitized: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      if (key === "_meta") {
        sanitized[key] = "[OMITTED]";
      } else if (SENSITIVE_TERMINAL_KEY.test(key)) {
        sanitized[key] = "[REDACTED]";
      } else {
        sanitized[key] = sanitizeTerminalValue(item, seen, depth + 1);
      }
    }
    return sanitized;
  }
  return redactTerminalString(String(value));
}

function terminalJson(value: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(sanitizeTerminalValue(value), null, 2) ?? "null";
  } catch {
    json = JSON.stringify("[UNSERIALIZABLE]");
  }
  if (json.length <= TERMINAL_JSON_LIMIT) return json;
  return `${json.slice(0, TERMINAL_JSON_LIMIT)}\n… [truncated ${json.length - TERMINAL_JSON_LIMIT} chars]`;
}

function terminalToolResult(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.structuredContent !== undefined) return record.structuredContent;
    if (record.content !== undefined) return record.content;
  }
  return value;
}

function mcpActivity(
  toolName: string,
  summary: string,
  status = "COMPLETE",
  details: { argumentsJson?: string; resultJson?: string; error?: string } = {},
) {
  return {
    event_id: `mcp-${crypto.randomUUID()}`,
    timestamp: new Date().toISOString(),
    type: "mcp.tool",
    payload: {
      tool_name: toolName,
      summary,
      status,
      ...(details.argumentsJson ? { arguments_json: details.argumentsJson } : {}),
      ...(details.resultJson ? { result_json: details.resultJson } : {}),
      ...(details.error ? { error: details.error } : {}),
    },
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
    },
  };
}

function activityResult<T extends Record<string, unknown>>(value: T, toolName: string, summary?: string) {
  return {
    ...result(value),
    _meta: {
      "cptr/activity": mcpActivity(toolName, summary ?? `ChatGPT completed ${toolName}.`),
    },
  };
}

function recordWorkbenchActivity(
  client: ComputerClient,
  sessionId: string | undefined,
  input: {
    event_type: string;
    summary: string;
    state?: string;
    target_type?: "task" | "monitor" | "command";
    target_id?: string;
    workspace_id?: string;
    tool_name?: string;
  },
): void {
  if (!sessionId) return;
  void client.appendWorkbenchSessionEvent({ session_id: sessionId, ...input }).catch(() => undefined);
}

const workspaceInsightOutputSchema = {
  workspace_id: z.string(),
  kind: z.string(),
};

const workbenchSessionOutputSchema = {
  session_id: z.string(),
  name: z.string(),
  workspace_id: z.string().nullable(),
  status: z.string(),
  active_target_type: z.enum(["task", "command", "monitor"]).nullable(),
  active_target_id: z.string().nullable(),
  active_workspace_id: z.string().nullable(),
  event_count: z.number().int(),
  created_at: z.number(),
  updated_at: z.number(),
  last_event_at: z.number().nullable(),
  archived_at: z.number().nullable(),
};

function initialWorkbenchResult<T extends Record<string, unknown>>(value: T, toolName: string) {
  return activityResult(
    value,
    toolName,
    "CPTR Workbench context is ready; render the Live Terminal once a task, monitor, or command target exists.",
  );
}

const oauthToolMetadata = {
  securitySchemes: [{ type: "oauth2", scopes: [] }],
};

const workbenchToolMetadata = oauthToolMetadata;

// One ChatGPT prompt gets exactly one UI-producing tool call: cptr_open_live_workbench.
// Every later CPTR tool only publishes activity/live metadata into that existing widget.
const openWorkbenchToolMetadata = {
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
  options: {
    tickets?: LiveTicketStore;
    promptSessions?: PromptTerminalStore;
    widgetBundle?: string;
    widgetStyles?: string;
    widgetAssets?: () => { bundle: string; styles: string };
    connectDomain?: string;
  } = {},
): McpServer {
  const server = new McpServer({ name: "chatgpt-computer-plugin", version: MCP_CONTRACT_VERSION });
  const tickets = options.tickets ?? new LiveTicketStore();
  const promptSessions = options.promptSessions ?? new PromptTerminalStore();
  let activePromptTicket: string | null = null;

  const publishActivity = (
    toolName: string,
    summary?: string,
    status = "COMPLETE",
    details: { argumentsJson?: string; resultJson?: string; error?: string } = {},
  ) => {
    const activity = mcpActivity(
      toolName,
      summary ?? `ChatGPT completed ${toolName}.`,
      status,
      details,
    );
    promptSessions.append(activePromptTicket, {
      type: "mcp.tool",
      payload: activity.payload,
    });
    return activity;
  };

  // Instrument every registered MCP action at the registration boundary. This
  // produces real-time WORK/TOOL CALL/ARGS and RESULT/FAILED rows without
  // exposing private chain-of-thought or transport-only metadata. Rich
  // task/monitor/command shell streams continue through the live.bind pipeline.
  const rawRegisterTool = server.registerTool.bind(server);
  (server as unknown as { registerTool: typeof server.registerTool }).registerTool = ((
    name: string,
    config: { title?: string },
    handler: (...args: unknown[]) => unknown,
  ) => rawRegisterTool(
    name as never,
    config as never,
    (async (...args: unknown[]) => {
      const label = config.title?.trim() || name;
      const input = args.length ? args[0] : {};
      publishActivity(
        name,
        `Working: ${label}.`,
        "STARTED",
        { argumentsJson: terminalJson(input) },
      );
      try {
        const value = await handler(...args);
        publishActivity(
          name,
          `Completed: ${label}.`,
          "COMPLETE",
          { resultJson: terminalJson(terminalToolResult(value)) },
        );
        return value as never;
      } catch (error) {
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        publishActivity(
          name,
          `Failed: ${label}.`,
          "FAILED",
          { error: redactTerminalString(message) },
        );
        throw error;
      }
    }) as never,
  )) as typeof server.registerTool;

  const activityResult = <T extends Record<string, unknown>>(
    value: T,
    _toolName?: string,
    _summary?: string,
  ) => result(value);

  const initialWorkbenchResult = <T extends Record<string, unknown>>(
    value: T,
    _toolName?: string,
  ) => result(value);

  const workbenchResult = <T extends Record<string, unknown>>(
    value: T,
    target: LiveTarget,
    _toolName?: string,
  ) => {
    const live = tickets.issue(target);
    promptSessions.append(activePromptTicket, {
      type: "live.bind",
      payload: { live },
    });
    return result(value);
  };
  server.registerResource(
    "cptr-live-workbench",
    WORKBENCH_RESOURCE_URI,
    {},
    async () => {
      const assets = options.widgetAssets?.() ?? {
        bundle: options.widgetBundle ?? "document.body.textContent = 'CPTR Live Workbench';",
        styles: options.widgetStyles ?? "",
      };
      return createWorkbenchResource(
        assets.bundle,
        options.connectDomain,
        assets.styles,
      );
    },
  );

  server.registerTool(
    "cptr_open_live_workbench",
    {
      title: "Prepare CPTR Live Workbench context",
      description:
        "Call this first whenever the user explicitly invokes CPTR. This is the sole CPTR UI-producing tool: it opens exactly one Live Terminal for the current prompt before any target exists. All later task, monitor, command, status, and render/bind calls are data-only and update this existing terminal instead of creating another widget.",
      inputSchema: openWorkbenchSessionSchema,
      outputSchema: {
        session_id: z.string(),
        name: z.string(),
        status: z.string(),
        workspace_id: z.string().nullable(),
        title: z.string(),
        initial_summary: z.string(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: openWorkbenchToolMetadata,
    },
    async (input) => {
      const prompt = promptSessions.open();
      activePromptTicket = prompt.ticket;
      const session = input.resume_session_id
        ? await client.getWorkbenchSession(input.resume_session_id)
        : await client.createWorkbenchSession({
            ...(input.session_name ? { name: input.session_name } : {}),
            ...(input.workspace_id ? { workspace_id: input.workspace_id } : {}),
          });
      const value = {
        session_id: session.session_id,
        name: session.name,
        status: session.status,
        workspace_id: session.workspace_id,
        title: "CPTR computer activity",
        initial_summary: `Workbench Session ${session.session_id} is ready. Later CPTR calls update this same terminal without creating another widget.`,
      };
      const activity = publishActivity(
        "cptr_open_live_workbench",
        "CPTR Live Terminal opened once for the current prompt.",
      );
      return {
        ...result(value),
        _meta: {
          "cptr/prompt": prompt,
          "cptr/activity": activity,
        },
      };
    },
  );

  server.registerTool(
    "cptr_plugin_update",
    {
      title: "Check CPTR plugin update",
      description:
        "Check the currently deployed CPTR Computer plugin release, read release notes, or verify the live MCP contract after the user refreshes the app in ChatGPT. This action cannot bypass ChatGPT's native app-action review or force the host to refresh its frozen tool snapshot.",
      inputSchema: pluginUpdateSchema,
      outputSchema: {
        action: z.string(),
        product: z.string(),
        version: z.string(),
        schema_revision: z.string(),
        contract_version: z.string(),
        tool_count: z.number().int(),
        release_sha: z.string().nullable(),
        released_at: z.string(),
        summary: z.string(),
        changes: z.array(z.string()),
        refresh_required: z.boolean(),
        refresh_reason: z.string(),
        refresh_path: z.array(z.string()),
        verification: z.object({
          tool: z.string(),
          arguments: z.record(z.string(), z.unknown()),
        }),
        contract_matches: z.boolean().optional(),
        tool_count_matches: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: workbenchToolMetadata,
    },
    async (input) => {
      const manifest = currentPluginUpdateManifest();
      const verification = input.action === "verify_server"
        ? {
            contract_matches:
              input.expected_contract_version === undefined ||
              input.expected_contract_version === manifest.contract_version,
            tool_count_matches:
              input.expected_tool_count === undefined ||
              input.expected_tool_count === manifest.tool_count,
          }
        : {};
      return activityResult(
        { action: input.action, ...manifest, ...verification },
        "cptr_plugin_update",
        input.action === "release_notes"
          ? `ChatGPT read CPTR Computer ${manifest.version} release notes.`
          : `ChatGPT checked CPTR Computer ${manifest.version} update status.`,
      );
    },
  );

  server.registerTool(
    "cptr_list_workbench_sessions",
    {
      title: "List CPTR Workbench Sessions",
      description: "List active or archived Workbench Sessions owned by the current CPTR user. Sessions are durable Plugin activity records, not live access tickets.",
      inputSchema: workbenchSessionListSchema,
      outputSchema: { sessions: z.array(z.record(z.string(), z.unknown())) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async (input) => activityResult(await client.listWorkbenchSessions(input), "cptr_list_workbench_sessions"),
  );

  server.registerTool(
    "cptr_get_workbench_session",
    {
      title: "Get a CPTR Workbench Session",
      description: "Get one current-user Workbench Session by opaque session ID. It never returns a live stream ticket or another user's session.",
      inputSchema: workbenchSessionIdSchema,
      outputSchema: workbenchSessionOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async ({ workbench_session_id }) => activityResult(await client.getWorkbenchSession(workbench_session_id), "cptr_get_workbench_session"),
  );

  server.registerTool(
    "cptr_get_workbench_session_events",
    {
      title: "Get CPTR Workbench Session activity",
      description: "Retrieve bounded, redacted, ordered activity for one current-user Workbench Session.",
      inputSchema: workbenchSessionEventsSchema,
      outputSchema: { session_id: z.string(), events: z.array(z.record(z.string(), z.unknown())), last_sequence: z.number().int() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async (input) => activityResult(await client.getWorkbenchSessionEvents({
      session_id: input.workbench_session_id,
      after_sequence: input.after_sequence,
      limit: input.limit,
    }), "cptr_get_workbench_session_events"),
  );

  server.registerTool(
    "cptr_bind_live_workbench_session",
    {
      title: "Bind the existing Live Workbench to a session target",
      description: "Bind an already-open Live Workbench to an owned task, monitor, or workspace-owned command inside a Workbench Session. This is data-only and never opens another widget.",
      inputSchema: workbenchSessionBindSchema,
      outputSchema: workbenchSessionOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: workbenchToolMetadata,
    },
    async (input) => {
      const session = await client.bindWorkbenchSession({
        session_id: input.workbench_session_id,
        target_type: input.target_type,
        target_id: input.target_id,
        ...(input.workspace_id ? { workspace_id: input.workspace_id } : {}),
      });
      let target: LiveTarget;
      if (input.target_type === "command") {
        const workspaceId = input.workspace_id;
        if (!workspaceId) throw new Error("workspace_id is required when binding a command target");
        target = { targetType: "command", targetId: input.target_id, workspaceId };
      } else {
        target = { targetType: input.target_type, targetId: input.target_id };
      }
      return workbenchResult(session, target, "cptr_bind_live_workbench_session");
    },
  );

  server.registerTool(
    "cptr_rename_workbench_session",
    {
      title: "Rename a CPTR Workbench Session",
      description: "Rename an owned Workbench Session only when the user explicitly requests a new name.",
      inputSchema: workbenchSessionRenameSchema,
      outputSchema: workbenchSessionOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async (input) => activityResult(await client.renameWorkbenchSession({ session_id: input.workbench_session_id, name: input.name }), "cptr_rename_workbench_session"),
  );

  server.registerTool(
    "cptr_archive_workbench_session",
    {
      title: "Archive a CPTR Workbench Session",
      description: "Archive an owned Workbench Session when the user asks to hide it from active sessions. Archiving is reversible and does not affect CPTR tasks, files, or workspaces.",
      inputSchema: workbenchSessionIdSchema,
      outputSchema: workbenchSessionOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async ({ workbench_session_id }) => activityResult(await client.archiveWorkbenchSession(workbench_session_id), "cptr_archive_workbench_session"),
  );

  server.registerTool(
    "cptr_request_delete_workbench_session",
    {
      title: "Request deletion of a CPTR Workbench Session",
      description: "Begin deletion of an owned Workbench Session only after the user explicitly asks. This returns a short-lived confirmation ID and deletes no data by itself.",
      inputSchema: workbenchSessionDeleteRequestSchema,
      outputSchema: { session_id: z.string(), confirmation_id: z.string(), expires_at: z.number(), event_count: z.number(), impact: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async ({ workbench_session_id }) => activityResult(await client.requestWorkbenchSessionDelete(workbench_session_id), "cptr_request_delete_workbench_session"),
  );

  server.registerTool(
    "cptr_confirm_delete_workbench_session",
    {
      title: "Confirm deletion of a CPTR Workbench Session",
      description: "Delete the session UI record and its redacted Plugin activity only after the user has clearly confirmed the deletion impact. It never deletes tasks, workspaces, files, or control audit records.",
      inputSchema: workbenchSessionDeleteConfirmSchema,
      outputSchema: { session_id: z.string(), status: z.string(), deleted_at: z.number() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async ({ confirmation_id }) => activityResult(await client.confirmWorkbenchSessionDelete(confirmation_id), "cptr_confirm_delete_workbench_session"),
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
    "cptr_workspace_detect_project",
    {
      title: "Detect an authorized CPTR workspace project",
      description: "Use this read-only tool to identify common project manifests and local runtimes in one selected CPTR workspace. It never runs code or opens files outside that workspace.",
      inputSchema: workspaceProjectSchema,
      outputSchema: workspaceInsightOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async (input) => activityResult(await client.inspectWorkspace({ ...input, kind: "project" }), "cptr_workspace_detect_project"),
  );

  server.registerTool(
    "cptr_workspace_tree",
    {
      title: "Inspect a bounded CPTR workspace tree",
      description: "Use this read-only tool to inspect a bounded tree inside the selected workspace. Generated and credential-sensitive directories remain excluded by CPTR.",
      inputSchema: workspaceTreeSchema,
      outputSchema: workspaceInsightOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async (input) => activityResult(await client.inspectWorkspace({ ...input, kind: "tree" }), "cptr_workspace_tree"),
  );

  server.registerTool(
    "cptr_workspace_file_metadata",
    {
      title: "Get safe CPTR workspace file metadata",
      description: "Use this read-only tool for one workspace-relative path's file type, size, and modification metadata. It does not return file content.",
      inputSchema: workspaceMetadataSchema,
      outputSchema: workspaceInsightOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async (input) => activityResult(await client.inspectWorkspace({ ...input, kind: "metadata" }), "cptr_workspace_file_metadata"),
  );

  server.registerTool(
    "cptr_workspace_read_many",
    {
      title: "Read multiple bounded CPTR workspace files",
      description: "Use this read-only tool when a small set of known workspace-relative text files must be compared. CPTR bounds file count and content and refuses binary or environment files.",
      inputSchema: workspaceReadManySchema,
      outputSchema: workspaceInsightOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async (input) => activityResult(await client.inspectWorkspace({ ...input, kind: "read_many" }), "cptr_workspace_read_many"),
  );

  server.registerTool(
    "cptr_workspace_search_symbols",
    {
      title: "Search symbols in an authorized CPTR workspace",
      description: "Use this read-only text search for an identifier, symbol, or literal within the selected workspace. It does not execute the project or fabricate terminal output.",
      inputSchema: workspaceSymbolSearchSchema,
      outputSchema: workspaceInsightOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async (input) => activityResult(await client.inspectWorkspace({ ...input, kind: "symbols" }), "cptr_workspace_search_symbols"),
  );

  server.registerTool(
    "cptr_workspace_discover_tests",
    {
      title: "Discover local tests in an authorized CPTR workspace",
      description: "Use this read-only inventory to find likely Python and JavaScript test files inside a bounded workspace tree. It does not run them.",
      inputSchema: workspaceTestDiscoverySchema,
      outputSchema: workspaceInsightOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async (input) => activityResult(await client.inspectWorkspace({ ...input, kind: "tests" }), "cptr_workspace_discover_tests"),
  );

  server.registerTool(
    "cptr_workspace_dependency_summary",
    {
      title: "Summarize local workspace dependencies",
      description: "Use this read-only tool to summarize dependencies declared in selected local project manifests. It does not resolve, install, update, or contact package registries.",
      inputSchema: workspaceDependencySchema,
      outputSchema: workspaceInsightOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async (input) => activityResult(await client.inspectWorkspace({ ...input, kind: "dependencies" }), "cptr_workspace_dependency_summary"),
  );

  server.registerTool(
    "cptr_workspace_package_scripts",
    {
      title: "List local workspace package scripts",
      description: "Use this read-only tool to inspect declared package.json scripts. It lists local metadata only and does not execute any script.",
      inputSchema: workspaceScriptsSchema,
      outputSchema: workspaceInsightOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async (input) => activityResult(await client.inspectWorkspace({ ...input, kind: "scripts" }), "cptr_workspace_package_scripts"),
  );

  server.registerTool(
    "cptr_workspace_release_readiness",
    {
      title: "Inspect static CPTR workspace release readiness",
      description: "Use this read-only static inventory to see whether a project manifest and likely tests are present. It is not release approval and does not execute code.",
      inputSchema: workspaceReleaseReadinessSchema,
      outputSchema: workspaceInsightOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async (input) => activityResult(await client.inspectWorkspace({ ...input, kind: "release" }), "cptr_workspace_release_readiness"),
  );

  server.registerTool(
    "cptr_workspace_run_test_target",
    {
      title: "Run a fixed local CPTR test profile",
      description: "Use this only after the user explicitly asks to run local validation in the selected workspace. Choose one server-owned test profile; arbitrary shell syntax, installs, and network access are not accepted. If workbench_session_id is supplied, CPTR streams actual bounded stdout/stderr to that durable session's terminal.",
      inputSchema: workspaceTestTargetSchema,
      outputSchema: {
        target: z.string(),
        workspace_id: z.string(),
        command_id: z.string(),
        status: z.string(),
        exit_code: z.number().int().nullable(),
        output: z.string(),
        next_offset: z.number().int(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: workbenchToolMetadata,
    },
    async (input) => {
      const { workbench_session_id, ...testInput } = input;
      const command = await client.runWorkspaceTestTarget(testInput);
      if (workbench_session_id) {
        await client.bindWorkbenchSession({
          session_id: workbench_session_id,
          target_type: "command",
          target_id: command.command_id,
          workspace_id: input.workspace_id,
        });
        recordWorkbenchActivity(client, workbench_session_id, {
          event_type: "test_profile.started",
          state: command.status,
          target_type: "command",
          target_id: command.command_id,
          workspace_id: input.workspace_id,
          tool_name: "cptr_workspace_run_test_target",
          summary: `ChatGPT started the CPTR ${command.target} test profile.`,
        });
      }
      return workbenchResult(
        { ...command, workspace_id: input.workspace_id },
        { targetType: "command", targetId: command.command_id, workspaceId: input.workspace_id },
        "cptr_workspace_run_test_target",
      );
    },
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
      const { workbench_session_id, ...commandInput } = input;
      const command = await client.runCodingCommand(commandInput);
      if (workbench_session_id) {
        await client.bindWorkbenchSession({
          session_id: workbench_session_id,
          target_type: "command",
          target_id: command.command_id,
          workspace_id: input.workspace_id,
        });
        recordWorkbenchActivity(client, workbench_session_id, {
          event_type: "command.started",
          state: command.status,
          target_type: "command",
          target_id: command.command_id,
          workspace_id: input.workspace_id,
          tool_name: "cptr_code_run_command",
          summary: "ChatGPT started a CPTR workspace command.",
        });
      }
      return workbenchResult(
        { ...command, workspace_id: input.workspace_id },
        { targetType: "command", targetId: command.command_id, workspaceId: input.workspace_id },
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
        "cptr_code_cancel_command",
      );
    },
  );

  server.registerTool(
    "cptr_ssh_list_hosts",
    {
      title: "List configured SSH host aliases",
      description:
        "List literal SSH Host aliases available to the authorized CPTR execution identity. This returns alias names only and never exposes private keys, IdentityFile contents, or other SSH config secrets.",
      inputSchema: sshHostsSchema,
      outputSchema: {
        workspace_id: z.string(),
        aliases: z.array(z.string()),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async (input) => activityResult(await client.listSshHosts(input), "cptr_ssh_list_hosts"),
  );

  server.registerTool(
    "cptr_ssh_run_command",
    {
      title: "Run a command through a configured SSH host alias",
      description:
        "Run an explicitly requested remote command through a configured SSH alias using CPTR's dedicated SSH control path. The generic coding-command tool does not permit raw SSH. CPTR preserves normal OpenSSH host-key verification and exposes resumable live command output.",
      inputSchema: sshCommandSchema,
      outputSchema: {
        workspace_id: z.string(),
        alias: z.string(),
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
      const command = await client.runSshCommand(input);
      return workbenchResult(
        command,
        { targetType: "command", targetId: command.command_id, workspaceId: input.workspace_id },
        "cptr_ssh_run_command",
      );
    },
  );

  server.registerTool(
    "cptr_ssh_get_command",
    {
      title: "Get SSH command status and incremental output",
      description:
        "Retrieve the current status and incremental output for a command previously started through CPTR's dedicated SSH control path.",
      inputSchema: sshCommandStatusSchema,
      outputSchema: {
        workspace_id: z.string(),
        alias: z.string(),
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
      const command = await client.getSshCommand(input);
      return workbenchResult(
        command,
        { targetType: "command", targetId: input.command_id, workspaceId: input.workspace_id },
        "cptr_ssh_get_command",
      );
    },
  );

  server.registerTool(
    "cptr_ssh_cancel_command",
    {
      title: "Cancel a running SSH command",
      description:
        "Stop a running command that was started through CPTR's dedicated SSH control path.",
      inputSchema: sshCommandCancelSchema,
      outputSchema: {
        workspace_id: z.string(),
        alias: z.string(),
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
      const command = await client.cancelSshCommand(input);
      return workbenchResult(
        command,
        { targetType: "command", targetId: input.command_id, workspaceId: input.workspace_id },
        "cptr_ssh_cancel_command",
      );
    },
  );

  server.registerTool(
    "cptr_chrome_browser",
    {
      title: "Control CPTR managed Chrome",
      description:
        "Control CPTR's isolated managed Chrome browser through one action-based tool. Use status to check availability; navigate for an explicit http/https URL; snapshot to obtain bounded accessibility refs; click/type with refs from the latest snapshot; press_key or scroll for interaction; screenshot to save a workspace-confined PNG; and close to end the scoped browser session. External navigation requires allow_network=true and CPTR's command:external scope. This tool never attaches to the user's normal Chrome profile by default and never returns cookies, auth headers, browser storage, or typed secret values.",
      inputSchema: chromeBrowserSchema,
      outputSchema: {
        workspace_id: z.string(),
        action: z.string(),
        status: z.string(),
        managed: z.boolean().optional(),
        available: z.boolean().optional(),
        active: z.boolean().optional(),
        browser: z.string().optional(),
        url: z.string().optional(),
        title: z.string().optional(),
        snapshot: z.string().optional(),
        truncated: z.boolean().optional(),
        screenshot_path: z.string().optional(),
        bytes: z.number().int().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      _meta: workbenchToolMetadata,
    },
    async (input) =>
      activityResult(
        await client.controlChromeBrowser(input),
        "cptr_chrome_browser",
        `ChatGPT used managed Chrome action: ${input.action}.`,
      ),
  );

  server.registerTool(
    "cptr_start_task",
    {
      title: "Start a CPTR task",
      description: "Use this when the user explicitly wants CPTR to start an engineering task in a selected workspace. When the user restricts writes, commands, network access, or package installation, encode those restrictions in execution_policy so CPTR enforces them server-side rather than relying on prompt wording.",
      inputSchema: startTaskSchema,
      outputSchema: { id: z.string(), status: z.string(), workspace_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: workbenchToolMetadata,
    },
    async (input) => {
      const { workbench_session_id, ...taskInput } = input;
      const task = await client.startTask({
        ...taskInput,
        prompt: workspaceScopedPrompt(input.prompt),
      });
      if (workbench_session_id) {
        await client.bindWorkbenchSession({
          session_id: workbench_session_id,
          target_type: "task",
          target_id: task.id,
          workspace_id: task.workspace_id,
        });
        recordWorkbenchActivity(client, workbench_session_id, {
          event_type: "task.started",
          state: task.status,
          target_type: "task",
          target_id: task.id,
          workspace_id: task.workspace_id,
          tool_name: "cptr_start_task",
          summary: "ChatGPT started a CPTR task.",
        });
      }
      return workbenchResult(task, { targetType: "task", targetId: task.id }, "cptr_start_task");
    },
  );

  server.registerTool(
    "cptr_execute_task",
    {
      title: "Execute a CPTR task now",
      description:
        "Use this only when the user explicitly asks ChatGPT to execute a contained task in a selected CPTR workspace. It starts an authorized CPTR task and waits up to 60 seconds for a result. If it remains active, return the task ID and use task-status tools rather than retrying. Encode user restrictions on writes, commands, network access, and package installation in execution_policy so CPTR enforces them server-side. This tool does not grant additional CPTR permissions; CPTR authorization and approval policy remain authoritative.",
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
      const { workbench_session_id, ...taskInput } = input;
      const task = await client.executeTask({
        ...taskInput,
        prompt: workspaceScopedPrompt(input.prompt),
      });
      if (workbench_session_id) {
        await client.bindWorkbenchSession({
          session_id: workbench_session_id,
          target_type: "task",
          target_id: task.task_id,
          workspace_id: task.workspace_id,
        });
        recordWorkbenchActivity(client, workbench_session_id, {
          event_type: "task.executed",
          state: task.status,
          target_type: "task",
          target_id: task.task_id,
          workspace_id: task.workspace_id,
          tool_name: "cptr_execute_task",
          summary: "ChatGPT executed a CPTR task.",
        });
      }
      return workbenchResult(task, { targetType: "task", targetId: task.task_id }, "cptr_execute_task");
    },
  );

  server.registerTool(
    "cptr_monitor_autonomous",
    {
      title: "Monitor a CPTR engineering goal",
      description: "Use this to create a persistent CPTR engineering monitor. The monitor continues server-side after the MCP call ends. Encode user restrictions on writes, commands, network access, and package installation in execution_policy; every spawned worker inherits those server-enforced limits.",
      inputSchema: monitorAutonomousSchema,
      outputSchema: autonomousSummaryOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: workbenchToolMetadata,
    },
    async (input) => {
      const { workbench_session_id, ...monitorInput } = input;
      const monitor = await client.createAutonomous(monitorInput);
      const monitorId = String(monitor.monitor_id ?? monitor.goal_id ?? "");
      if (!monitorId) return activityResult(monitor, "cptr_monitor_autonomous");
      if (workbench_session_id) {
        await client.bindWorkbenchSession({
          session_id: workbench_session_id,
          target_type: "monitor",
          target_id: monitorId,
          workspace_id: input.workspace_id,
        });
        recordWorkbenchActivity(client, workbench_session_id, {
          event_type: "monitor.started",
          state: String(monitor.status ?? "RUNNING"),
          target_type: "monitor",
          target_id: monitorId,
          workspace_id: input.workspace_id,
          tool_name: "cptr_monitor_autonomous",
          summary: "ChatGPT started a CPTR autonomous monitor.",
        });
      }
      return workbenchResult(monitor, { targetType: "monitor", targetId: monitorId }, "cptr_monitor_autonomous");
    },
  );

  server.registerTool(
    "cptr_render_live_terminal",
    {
      title: "Render the CPTR Live Terminal",
      description:
        "Bind or refresh the already-open CPTR Live Terminal to a task, monitor, or workspace-owned command target. This tool is data-only and must never create another widget; cptr_open_live_workbench is the sole UI-producing call for the prompt. The terminal remains redacted and resumable and this binding grants no additional permissions.",
      inputSchema: z.object({
        target_type: z.enum(["task", "monitor", "command"]),
        target_id: z.string().min(1),
        workspace_id: z.string().min(1).max(200).optional(),
        workbench_session_id: z.string().regex(/^wbs_[A-Za-z0-9_-]{16,80}$/).optional(),
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
    async ({ target_type, target_id, workspace_id, workbench_session_id }) => {
      const bindSession = async (resolvedWorkspaceId?: string) => {
        if (!workbench_session_id) return;
        if (target_type === "command" && !resolvedWorkspaceId) {
          throw new Error("workspace_id is required when binding a command target");
        }
        await client.bindWorkbenchSession({
          session_id: workbench_session_id,
          target_type,
          target_id,
          ...(resolvedWorkspaceId ? { workspace_id: resolvedWorkspaceId } : {}),
        });
        recordWorkbenchActivity(client, workbench_session_id, {
          event_type: "terminal.bound",
          target_type,
          target_id,
          ...(resolvedWorkspaceId ? { workspace_id: resolvedWorkspaceId } : {}),
          tool_name: "cptr_render_live_terminal",
          summary: "ChatGPT bound the Live Terminal to an owned CPTR target.",
        });
      };
      if (target_type === "task") {
        const task = await client.getTask(target_id);
        await bindSession(task.workspace_id);
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
        await bindSession(workspace_id);
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
          "cptr_render_live_terminal",
        );
      }
      const monitor = await client.getAutonomous(target_id);
      const status = String(monitor.status ?? "UNKNOWN");
      await bindSession(workspace_id);
      return workbenchResult(
        {
          target_type,
          target_id,
          status,
          title: "CPTR autonomous monitor",
          initial_summary: `Monitor ${target_id} is ${status}.`,
        },
        { targetType: target_type, targetId: target_id },
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
