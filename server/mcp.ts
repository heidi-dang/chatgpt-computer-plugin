import { AsyncLocalStorage } from "node:async_hooks";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ComputerApiError, ComputerClient } from "./client/computer-client.js";
import { telemetryInputForTool } from "./browser-telemetry.js";
import { McpActivityEmitter } from "./mcp-activity.js";
import { McpDiagnosticsEmitter } from "./mcp-diagnostics.js";
import {
  canonicalMcpResultEnvelope,
  canonicalToolCallEnvelope,
  estimateModelTokens,
  normalizeReportedModel,
} from "./mcp-usage.js";
import {
  McpTrafficEmitter,
  enrichMcpClientSession,
  mcpRequestContext,
  normalizeMcpClient,
  normalizeTrafficErrorCode,
  type McpRequestContextValue,
} from "./mcp-traffic.js";
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
  benchmarkLeaderboardSchema,
  benchmarkRunSchema,
  benchmarkStartSchema,
  directWorkerCreateSchema,
  directWorkerListSchema,
  directWorkerGetSchema,
  directWorkersOverviewSchema,
  directWorkersIntegrateSchema,
  directWorkerCloseSchema,
  codingCommandCancelSchema,
  codingCommandInputSchema,
  codingCommandResizeSchema,
  codingCommandSignalSchema,
  codingCommandSchema,
  codingCommandStatusSchema,
  codingDeleteSchema,
  codingDirectorySchema,
  codingEditSchema,
  fdxIntelligenceSchema,
  codingListSchema,
  codingMoveSchema,
  codingReadSchema,
  codingSearchSchema,
  codingWriteSchema,
  chromeBrowserSchema,
  userChromeSchema,
  executeTaskSchema,
  factoryApprovalSchema,
  factoryControlSchema,
  factoryMessageSchema,
  factoryPageSchema,
  factoryRunIdSchema,
  factoryStartSchema,
  factoryStopSchema,
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
  listWorkspacesSchema,
  listTasksSchema,
  listAutonomousSchema,
  taskEventsSchema,
  autonomousEventsSchema,
  autonomousEvidenceSchema,
  taskOutputSchema,
  taskReviewSchema,
  gitStatusSchema,
  gitDiffSchema,
  lspDiscoverSchema,
  lspStartSchema,
  lspRequestSchema,
  lspStopSchema,
  readManyFilesSchema,
  applyEditsSchema,
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

function delegatedPrompt(prompt: string): string {
  const value = prompt.trim();
  if (/(^|\s)allow:delegate(?=\s|$)/i.test(value)) return value;
  return `${value}\n\nDelegation authorization: allow:delegate`;
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

const factoryRunControlOutputSchema = {
  run_id: z.string(),
  state: z.string(),
};
const factoryStatusOutputSchema = {
  run_id: z.string(),
  workspace_id: z.string(),
  state: z.string(),
  current_cycle_id: z.string().nullable(),
  resumable_state: z.string().nullable(),
  next_action: z.string().nullable(),
  mission: z.string(),
  acceptance_criteria: z.array(z.string()),
  policy: z.record(z.string(), z.unknown()),
  budget: z.record(z.string(), z.unknown()),
  cycle: z.record(z.string(), z.unknown()).nullable(),
  progress: z.record(z.string(), z.unknown()),
  pending_approval: z.record(z.string(), z.unknown()).nullable(),
  gates: z.array(z.record(z.string(), z.unknown())),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  completed_at: z.number().int().nullable(),
};
const factoryPageMetadataOutputSchema = {
  next_cursor: z.string().nullable(),
  max_bytes: z.number().int().nonnegative(),
  bytes_returned: z.number().int().nonnegative(),
  truncated: z.boolean(),
};

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

const benchmarkTaskOutputSchema = z.object({
  id: z.string(),
  file: z.string(),
  points: z.number().int().nonnegative(),
  instruction: z.string(),
});
const benchmarkCaseOutputSchema = z.object({
  id: z.string(),
  passed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  points: z.number().int().nonnegative(),
  max_points: z.number().int().nonnegative(),
  error_kinds: z.array(z.string()),
});
const benchmarkRunOutputSchema = {
  run_id: z.string(),
  suite_id: z.string(),
  suite_version: z.string(),
  status: z.string(),
  model_reported: z.string().nullable(),
  model_canonical: z.string().nullable(),
  workspace_id: z.string().nullable(),
  score: z.number().int().nullable(),
  max_score: z.number().int().nonnegative(),
  case_results: z.array(benchmarkCaseOutputSchema),
  error_summary: z.string().nullable(),
  started_at_ms: z.number().int().nonnegative(),
  completed_at_ms: z.number().int().nonnegative().nullable(),
  duration_ms: z.number().int().nonnegative().nullable(),
  comparable: z.literal(true),
  comparability: z.literal("standardized_suite_only"),
  tasks: z.array(benchmarkTaskOutputSchema),
  grader_seed: z.string().optional(),
};
const benchmarkLeaderboardOutputSchema = {
  comparable: z.literal(true),
  comparability: z.literal("standardized_suite_only"),
  suite_id: z.string(),
  suite_version: z.string(),
  max_score: z.number().int().nonnegative(),
  models: z.array(z.object({
    model_canonical: z.string(),
    model_reported: z.string().nullable(),
    attempts: z.number().int().nonnegative(),
    best_score: z.number().int().nonnegative(),
    average_score: z.number().nonnegative(),
    perfect_runs: z.number().int().nonnegative(),
    pass_rate: z.number().min(0).max(1),
    median_duration_ms: z.number().int().nonnegative(),
  })),
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

const liveEventOutputSchema = z.object({
  version: z.number().int(),
  event_id: z.string(),
  sequence: z.number().int().nonnegative(),
  timestamp: z.string(),
  target: z.object({ type: z.string(), id: z.string() }),
  task_id: z.string().nullable(),
  monitor_id: z.string().nullable(),
  worker_task_id: z.string().nullable(),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  redaction_applied: z.boolean(),
});

const taskListItemOutputSchema = z.object({
  id: z.string(),
  task_id: z.string(),
  workspace_id: z.string(),
  status: z.string(),
  review_status: z.string(),
  error: z.string().nullable(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});

const directWorkerOutputSchema = {
  worker_id: z.string(),
  workspace_id: z.string(),
  name: z.string(),
  responsibility: z.string(),
  repo_path: z.string(),
  status: z.string(),
  branch: z.string(),
  base_revision: z.string(),
  changed_file_count: z.number().int().nonnegative(),
  changed_paths: z.array(z.string()),
  active_command_ids: z.array(z.string()),
  recent_command_ids: z.array(z.string()),
  created_at: z.number(),
  updated_at: z.number(),
  integrated_at: z.number().nullable(),
  closed_at: z.number().nullable(),
};

const directCommandOutputSchema = {
  workspace_id: z.string(),
  command_id: z.string(),
  status: z.string(),
  exit_code: z.number().int().nullable(),
  output: z.string(),
  next_offset: z.number().int().nonnegative(),
  duration_ms: z.number().int().nonnegative(),
  output_truncated: z.boolean(),
  timed_out: z.boolean(),
  pty: z.boolean().optional(),
  rows: z.number().int().optional(),
  cols: z.number().int().optional(),
  recovered: z.boolean().optional(),
};

const autonomousSummaryOutputSchema = {
  monitor_id: z.string(),
  goal_id: z.string(),
  workspace_id: z.string(),
  status: z.string(),
  scope_count: z.number().int(),
  verified_count: z.number().int(),
  current_scope: z.string().nullable(),
  original_goal: z.string(),
  acceptance_criteria: z.array(z.string()),
  approval_id: z.string().nullable(),
  approval: z.object({
    approval_id: z.string(),
    operation: z.string(),
    reason: z.string(),
    status: z.string(),
    requested_at: z.number().int(),
  }).optional(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  quiesced: z.boolean().optional(),
  scopes: z.array(z.object({
    scope_id: z.string(),
    title: z.string(),
    status: z.string(),
    verified: z.boolean(),
  }).passthrough()),
};

const DELEGATED_AGENT_TOOL_NAMES = new Set([
  "cptr_list_models",
  "cptr_list_tasks",
  "cptr_list_autonomous",
  "cptr_get_task_events",
  "cptr_start_task",
  "cptr_execute_task",
  "cptr_monitor_autonomous",
  "cptr_get_autonomous",
  "cptr_get_autonomous_events",
  "cptr_get_autonomous_evidence",
  "cptr_steer_autonomous",
  "cptr_cancel_autonomous",
  "cptr_approve_autonomous",
  "cptr_get_task",
  "cptr_get_task_output",
  "cptr_get_task_review",
  "cptr_decide_task_review",
  "cptr_send_message",
  "cptr_cancel_task",
]);

const RESUMABLE_COMMAND_TOOL_NAMES = new Set([
  "cptr_workspace_run_test_target",
  "cptr_code_run_command",
  "cptr_code_get_command",
  "cptr_ssh_run_command",
  "cptr_ssh_get_command",
]);
const RUN_STATUS_RESUMABLE_TOOL_NAMES = new Set(["cptr_factory_stop"]);

export const MCP_REGISTERED_TOOL_BUDGET = 90;
export type McpToolSurfaceProfile = {
  registered_tools: number;
  direct_tools: number;
  delegated_tools: number;
  registration_ms: number;
  budget: number;
};
const toolSurfaceProfiles = new WeakMap<McpServer, McpToolSurfaceProfile>();

export function getMcpToolSurfaceProfile(server: McpServer): McpToolSurfaceProfile | null {
  const profile = toolSurfaceProfiles.get(server);
  return profile ? { ...profile } : null;
}

const DIRECT_GROUP_DESCRIPTION =
  "Tool group: ChatGPT Direct Coding. This is the default execution path. ChatGPT itself must inspect, edit, run, verify, browse, or operate the selected workspace through these bounded CPTR primitives; do not delegate the work to a CPTR model, agent profile, Codex, Hermes, or another autonomous coding agent. For source-code understanding, repository navigation, symbols, dependencies, architecture, change impact, affected tests, or related-file reasoning, prefer cptr_fdx_intelligence first when available; if FDX reports unavailable, degraded, unsupported, or insufficient evidence, fall back to the ordinary CPTR Direct Coding tools. Exact CPTR file reads remain required before mutation.";
const DELEGATE_GROUP_DESCRIPTION =
  "Tool group: Delegated Agent. This tool is model/agent-backed CPTR orchestration or lifecycle control. It is blocked unless the current user prompt contains the exact opt-in token `allow:delegate` and the prompt Workbench session was opened with delegation_authorization=`allow:delegate`. The opt-in applies to CPTR native agents/models and other agent profiles such as Codex or Hermes.";

export const CLIENT_MODEL_INSTRUCTION =
  "When you are ChatGPT and invoke any CPTR tool, set client_model to the exact current model identity you are running as for this tool call, for example GPT-5.6 Sol. Report the current value on every CPTR tool call; do not reuse or infer it from an earlier call. If the current model identity is unavailable, omit client_model rather than guessing.";
export const CLIENT_MODEL_FIELD_DESCRIPTION =
  "ChatGPT callers: set client_model to the exact current ChatGPT model identity for this tool call, for example GPT-5.6 Sol. Report client_model on every CPTR call; if unavailable, omit this optional field rather than guessing.";
const clientModelSchema = z.string().min(1).max(120).optional().describe(CLIENT_MODEL_FIELD_DESCRIPTION);

type ModelAwareToolConfig = {
  title?: string;
  description?: string;
  inputSchema?: unknown;
};

function withClientModelInputSchema(inputSchema: unknown): unknown {
  if (inputSchema instanceof z.ZodObject) {
    return inputSchema.extend({ client_model: clientModelSchema });
  }
  if (inputSchema && typeof inputSchema === "object" && !Array.isArray(inputSchema)) {
    return { ...(inputSchema as Record<string, z.ZodTypeAny>), client_model: clientModelSchema };
  }
  return { client_model: clientModelSchema };
}

export function extractClientModel(input: unknown): { reported: string | null; handlerInput: unknown } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { reported: null, handlerInput: input };
  }
  const record = { ...(input as Record<string, unknown>) };
  const raw = record.client_model;
  delete record.client_model;
  const reported = typeof raw === "string" ? raw.trim().slice(0, 120) || null : null;
  return { reported, handlerInput: record };
}

function groupedToolConfig<T extends ModelAwareToolConfig>(name: string, config: T): T {
  const delegated = DELEGATED_AGENT_TOOL_NAMES.has(name);
  const groupName = delegated ? "Delegated Agent" : "ChatGPT Direct Coding";
  const policy = delegated ? DELEGATE_GROUP_DESCRIPTION : DIRECT_GROUP_DESCRIPTION;
  const conditional = name === "cptr_render_live_terminal"
    ? " Command-target binding is direct; task/monitor binding is delegated-agent lifecycle access and therefore also requires the prompt-session `allow:delegate` capability."
    : "";
  const resumeFirst = RESUMABLE_COMMAND_TOOL_NAMES.has(name)
    ? " Long-running execution is ID/resume-first: keep wait_seconds at 0 unless a short bounded wait is explicitly useful, retain the returned command_id, and resume through the matching status/output action."
    : RUN_STATUS_RESUMABLE_TOOL_NAMES.has(name)
      ? " Quiescence is run-ID/status-first: each stop attempt is bounded to 15 seconds; if work is still active, retain run_id and continue with cptr_factory_status before another bounded stop attempt."
      : "";
  return {
    ...config,
    title: `[${groupName}] ${config.title?.trim() || name}`,
    description: `${policy}${conditional}${resumeFirst}${config.description ? ` ${config.description}` : ""} ${CLIENT_MODEL_FIELD_DESCRIPTION}`,
    inputSchema: withClientModelInputSchema(config.inputSchema),
  };
}

function requiresDelegationAuthorization(name: string, input: unknown): boolean {
  if (DELEGATED_AGENT_TOOL_NAMES.has(name)) return true;
  if (name !== "cptr_render_live_terminal" || !input || typeof input !== "object") return false;
  const targetType = (input as { target_type?: unknown }).target_type;
  return targetType === "task" || targetType === "monitor";
}

export function createMcpServer(
  client: ComputerClient,
  options: {
    tickets?: LiveTicketStore;
    promptSessions?: PromptTerminalStore;
    liveTerminalStreamingEnabled?: boolean;
    widgetBundle?: string;
    widgetStyles?: string;
    widgetAssets?: () => { bundle: string; styles: string };
    connectDomain?: string;
    traffic?: McpTrafficEmitter;
    activityTelemetry?: McpActivityEmitter;
    diagnostics?: McpDiagnosticsEmitter;
  } = {},
): McpServer {
  const registrationStartedAt = performance.now();
  let registeredToolCount = 0;
  let delegatedToolCount = 0;
  const server = new McpServer(
    { name: "chatgpt-computer-plugin", version: MCP_CONTRACT_VERSION },
    { instructions: CLIENT_MODEL_INSTRUCTION },
  );
  const tickets = options.tickets ?? new LiveTicketStore();
  const promptSessions = options.promptSessions ?? new PromptTerminalStore();
  const liveTerminalStreamingEnabled = options.liveTerminalStreamingEnabled ?? true;
  let activePromptTicket: string | null = null;
  const promptTicketContext = new AsyncLocalStorage<string | null>();
  const clientModelContext = new AsyncLocalStorage<string | null>();

  const currentPromptTicket = (): string | null => {
    const contextual = promptTicketContext.getStore();
    return contextual === undefined ? activePromptTicket : contextual;
  };

  const workbenchSessionIdFrom = (value: unknown): string | undefined => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const id = record.workbench_session_id ?? record.resume_session_id;
    return typeof id === "string" && id ? id : undefined;
  };

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
    promptSessions.append(currentPromptTicket(), {
      type: "mcp.tool",
      payload: activity.payload,
    });
    return activity;
  };

  const publishBrowserSurface = (input: Record<string, unknown>, result: Record<string, unknown>) => {
    const commandResult = recordFrom(result.result);
    const commandPayload = recordFrom(commandResult.payload);
    const topLevelLease = recordFrom(result.lease);
    const nestedLease = recordFrom(commandPayload.lease);
    const lease = Object.keys(topLevelLease).length > 0 ? topLevelLease : nestedLease;
    const sessionId = result.session_id ?? input.session_id ?? lease.session_id;
    // Device discovery and pairing are not browser surfaces. Publishing a
    // browser.surface before a real session exists switches the Workbench to
    // an empty canvas that can never legally poll the frame gateway.
    if (typeof sessionId !== "string" || !sessionId) return;
    const payload: {
      action: string;
      device_id?: string;
      session_id: string;
      state?: string;
      owner?: string;
      epoch?: number;
      hostname?: string;
    } = {
      action: typeof input.action === "string" ? input.action : "unknown",
      session_id: sessionId.slice(0, 200),
    };
    const action = typeof input.action === "string" ? input.action : "unknown";
    const semanticOwner = result.owner
      ?? lease.owner
      ?? ((action === "command" || action === "approve_evaluate") ? "agent" : input.expected_owner);
    const semanticState = result.state
      ?? lease.state
      ?? (semanticOwner === "agent"
        ? "AGENT_CONTROL"
        : semanticOwner === "human"
          ? "HUMAN_CONTROL"
          : semanticOwner === "none"
            ? "DISCONNECTED"
            : undefined);
    for (const [key, value] of [
      ["device_id", result.device_id ?? input.device_id],
      ["state", semanticState],
      ["owner", semanticOwner],
      ["hostname", result.hostname ?? input.hostname],
    ] as const) {
      if (typeof value === "string" && value) payload[key] = value.slice(0, 200);
    }
    const epoch = result.epoch ?? lease.epoch ?? input.expected_epoch;
    if (typeof epoch === "number" && Number.isInteger(epoch) && epoch >= 0) payload.epoch = epoch;
    // Once a browser session has been rendered into one prompt, all later
    // command/handoff events must return to that same card. Falling back to the
    // process-wide active prompt can strand an older widget in AGENT_CONTROL
    // when another ChatGPT prompt becomes active between browser calls.
    const promptTicket = promptSessions.ticketForBrowserSession(sessionId) ?? currentPromptTicket();
    promptSessions.append(promptTicket, { type: "browser.surface", payload });
  };

  const publishDirectWorker = (payload: {
    worker_id: string;
    workspace_id?: string;
    name?: string;
    responsibility?: string;
    repo_path?: string;
    status?: string;
    summary?: string;
    changed_file_count?: number;
    changed_paths?: string[];
    active_command_ids?: string[];
    recent_command_ids?: string[];
  }) => promptSessions.append(currentPromptTicket(), { type: "direct.worker", payload });

  const workerIdFrom = (value: unknown): string | undefined => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const id = (value as Record<string, unknown>).worker_id;
    return typeof id === "string" && id ? id : undefined;
  };

  const recordFrom = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

  const workspaceNameFor = async (workspaceId: string | null): Promise<string | null> => {
    if (!workspaceId) return null;
    try {
      const workspaces = await client.listWorkspaces(false);
      return workspaces.workspaces.find((workspace) => workspace.workspace_id === workspaceId)?.name ?? null;
    } catch {
      return null;
    }
  };

  const applyTrafficIdentity = async (
    context: McpRequestContextValue | undefined,
    toolName: string,
    inputValue: unknown,
    model: string | null,
    resultValue?: unknown,
  ): Promise<void> => {
    if (!context?.sessionId) return;
    const inputRecord = recordFrom(inputValue);
    const resultRecord = recordFrom(resultValue);
    const workspaceId = typeof resultRecord.workspace_id === "string"
      ? resultRecord.workspace_id
      : typeof inputRecord.workspace_id === "string"
        ? inputRecord.workspace_id
        : context.client.workspace_id;
    const workspaceName = workspaceId && workspaceId !== context.client.workspace_id
      ? await workspaceNameFor(workspaceId)
      : context.client.workspace_name;
    const sessionName = toolName === "cptr_open_live_workbench" && typeof resultRecord.name === "string"
      ? resultRecord.name
      : typeof inputRecord.session_name === "string"
        ? inputRecord.session_name
        : context.client.session_name;
    Object.assign(context.client, enrichMcpClientSession(context.client, {
      sessionId: context.sessionId,
      sessionName,
      model,
      workspaceId,
      workspaceName,
    }));
  };

  const publishWorkerResult = (input: unknown, value: unknown, summary: string) => {
    const resultValue = terminalToolResult(value);
    const inputRecord = input && typeof input === "object" && !Array.isArray(input)
      ? input as Record<string, unknown>
      : {};
    const resultRecord = resultValue && typeof resultValue === "object" && !Array.isArray(resultValue)
      ? resultValue as Record<string, unknown>
      : {};
    const workers = Array.isArray(resultRecord.workers) ? resultRecord.workers : [];
    if (workers.length) {
      for (const item of workers) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const worker = item as Record<string, unknown>;
        const workerId = workerIdFrom(worker);
        if (!workerId) continue;
        publishDirectWorker({
          worker_id: workerId,
          workspace_id: typeof worker.workspace_id === "string" ? worker.workspace_id : undefined,
          name: typeof worker.name === "string" ? worker.name : undefined,
          responsibility: typeof worker.responsibility === "string" ? worker.responsibility : undefined,
          repo_path: typeof worker.repo_path === "string" ? worker.repo_path : undefined,
          status: typeof worker.status === "string" ? worker.status : undefined,
          summary,
          changed_file_count: typeof worker.changed_file_count === "number" ? worker.changed_file_count : undefined,
          changed_paths: Array.isArray(worker.changed_paths) ? worker.changed_paths.filter((path): path is string => typeof path === "string") : undefined,
          active_command_ids: Array.isArray(worker.active_command_ids) ? worker.active_command_ids.filter((id): id is string => typeof id === "string") : undefined,
          recent_command_ids: Array.isArray(worker.recent_command_ids) ? worker.recent_command_ids.filter((id): id is string => typeof id === "string") : undefined,
        });
      }
      return;
    }
    const workerId = workerIdFrom(resultRecord) ?? workerIdFrom(inputRecord);
    if (!workerId) return;
    publishDirectWorker({
      worker_id: workerId,
      workspace_id: typeof resultRecord.workspace_id === "string"
        ? resultRecord.workspace_id
        : typeof inputRecord.workspace_id === "string" ? inputRecord.workspace_id : undefined,
      name: typeof resultRecord.name === "string" ? resultRecord.name : undefined,
      responsibility: typeof resultRecord.responsibility === "string" ? resultRecord.responsibility : undefined,
      repo_path: typeof resultRecord.repo_path === "string" ? resultRecord.repo_path : undefined,
      status: typeof resultRecord.status === "string" ? resultRecord.status : "WORKING",
      summary,
      changed_file_count: typeof resultRecord.changed_file_count === "number" ? resultRecord.changed_file_count : undefined,
      changed_paths: Array.isArray(resultRecord.changed_paths) ? resultRecord.changed_paths.filter((path): path is string => typeof path === "string") : undefined,
      active_command_ids: Array.isArray(resultRecord.active_command_ids) ? resultRecord.active_command_ids.filter((id): id is string => typeof id === "string") : undefined,
      recent_command_ids: Array.isArray(resultRecord.recent_command_ids) ? resultRecord.recent_command_ids.filter((id): id is string => typeof id === "string") : undefined,
    });
  };

  // Instrument every registered MCP action at the registration boundary. This
  // produces real-time WORK/TOOL CALL/ARGS and RESULT/FAILED rows without
  // exposing private chain-of-thought or transport-only metadata. Rich
  // task/monitor/command shell streams continue through the live.bind pipeline.
  const rawRegisterTool = server.registerTool.bind(server);
  (server as unknown as { registerTool: typeof server.registerTool }).registerTool = ((
    name: string,
    config: { title?: string; description?: string },
    handler: (...args: unknown[]) => unknown,
  ) => {
    const groupedConfig = groupedToolConfig(name, config);
    registeredToolCount += 1;
    if (DELEGATED_AGENT_TOOL_NAMES.has(name)) delegatedToolCount += 1;
    return rawRegisterTool(
      name as never,
      groupedConfig as never,
      (async (...args: unknown[]) => {
        const label = groupedConfig.title?.trim() || name;
        const originalInput = args.length ? args[0] : {};
        const { reported: reportedClientModel, handlerInput: input } = extractClientModel(originalInput);
        const mappedPromptTicket = promptSessions.ticketForWorkbenchSession(workbenchSessionIdFrom(input));
        promptTicketContext.enterWith(mappedPromptTicket ?? activePromptTicket);
        const normalizedModel = normalizeReportedModel(reportedClientModel);
        const inputWorkerId = workerIdFrom(input);
        const trafficContext = mcpRequestContext.getStore();
        const trafficStartedAt = Date.now();
        await applyTrafficIdentity(trafficContext, name, input, normalizedModel.reported);
        let activityClient = trafficContext?.client ?? normalizeMcpClient(undefined);
        const activityArgumentsJson = terminalJson(telemetryInputForTool(name, input));
        const modelGeneratedArguments = trafficContext?.rawToolArguments ?? originalInput;
        const emitUsage = (status: "complete" | "error", returnedEnvelope: unknown) => {
          if (!options.diagnostics) return;
          try {
            // Billing orientation is from the model's perspective: ChatGPT-generated
            // raw tool-call arguments are model output, while MCP results fed back to
            // ChatGPT are model input. For HTTP MCP calls, use the transient raw
            // request arguments so schema defaults injected by the SDK are not billed
            // as model-generated tokens.
            const toolCallOutputEstimate = estimateModelTokens(
              normalizedModel.canonical,
              canonicalToolCallEnvelope(name, modelGeneratedArguments),
            );
            const toolResultInputEstimate = estimateModelTokens(
              normalizedModel.canonical,
              canonicalMcpResultEnvelope(returnedEnvelope),
            );
            options.diagnostics.usage({
              request_id: trafficContext?.requestId ?? null,
              correlation_id: trafficContext?.correlationId ?? null,
              session_id: trafficContext?.sessionId ?? null,
              client_id: activityClient.id,
              model_reported: normalizedModel.reported,
              model_canonical: normalizedModel.canonical,
              model_source: normalizedModel.reported ? "self_reported" : "unavailable",
              tool_name: name,
              input_tokens_estimated: toolResultInputEstimate.tokens,
              output_tokens_estimated: toolCallOutputEstimate.tokens,
              cached_input_tokens_estimated: null,
              estimator_method: `input=${toolResultInputEstimate.method};output=${toolCallOutputEstimate.method}`,
              estimator_exact_for_model:
                toolResultInputEstimate.exact_for_model && toolCallOutputEstimate.exact_for_model,
              status,
            });
          } catch {
            // Usage simulation is best-effort observability and must never alter a tool result.
          }
        };
        options.traffic?.toolStarted(name, trafficContext);
        options.activityTelemetry?.started({
          client: activityClient,
          sessionId: trafficContext?.sessionId ?? null,
          requestId: trafficContext?.requestId ?? null,
          correlationId: trafficContext?.correlationId ?? null,
          toolName: name,
          title: label,
          summary: `Working: ${label}.`,
          argumentsJson: activityArgumentsJson,
        });
        const workerScoped = Boolean(inputWorkerId) || name.startsWith("cptr_direct_worker");
        if (inputWorkerId) {
          const inputRecord = input as Record<string, unknown>;
          publishDirectWorker({
            worker_id: inputWorkerId,
            workspace_id: typeof inputRecord.workspace_id === "string" ? inputRecord.workspace_id : undefined,
            status: "WORKING",
            summary: `ChatGPT is using ${label}.`,
          });
        } else if (!workerScoped) {
          publishActivity(
            name,
            `Working: ${label}.`,
            "STARTED",
            { argumentsJson: activityArgumentsJson },
          );
        }
        try {
          if (
            requiresDelegationAuthorization(name, input) &&
            !promptSessions.allowsDelegation(currentPromptTicket())
          ) {
            throw new ComputerApiError(
              403,
              "delegated-agent tools are disabled for this prompt; the user must include the exact token allow:delegate and cptr_open_live_workbench must record that authorization for the current prompt session",
              "delegation_not_allowed",
              false,
              "allow:delegate",
            );
          }
          const value = await clientModelContext.run(
            normalizedModel.reported,
            async () => handler(...(args.length ? [input, ...args.slice(1)] : args)),
          );
          const activityDurationMs = Date.now() - trafficStartedAt;
          const terminalValue = terminalToolResult(value);
          await applyTrafficIdentity(trafficContext, name, input, normalizedModel.reported, terminalValue);
          activityClient = trafficContext?.client ?? activityClient;
          const activityResultJson = terminalJson(terminalValue);
          const valueRecord = value && typeof value === "object" && !Array.isArray(value)
            ? value as Record<string, unknown>
            : null;
          const returnedToolError = valueRecord?.isError === true;
          if (returnedToolError) {
            if (trafficContext) {
              trafficContext.outcome.failed = true;
              trafficContext.outcome.errorCode = "tool_error";
            }
            options.traffic?.toolFailed(name, { code: "tool_error", kind: "tool_error" }, trafficContext, activityDurationMs);
            options.activityTelemetry?.failed({
              client: activityClient,
              sessionId: trafficContext?.sessionId ?? null,
              requestId: trafficContext?.requestId ?? null,
              correlationId: trafficContext?.correlationId ?? null,
              toolName: name,
              title: label,
              summary: `Failed: ${label}.`,
              errorJson: activityResultJson,
              durationMs: activityDurationMs,
            });
            options.diagnostics?.failure({
              request_id: trafficContext?.requestId ?? null,
              correlation_id: trafficContext?.correlationId ?? null,
              session_id: trafficContext?.sessionId ?? null,
              client_id: activityClient.id,
              method: trafficContext?.method ?? null,
              tool_name: name,
              stage: "cptr_mcp",
              error_code: "tool_error",
              http_status: null,
              retryable: false,
              started_at_ms: trafficStartedAt,
              duration_ms: activityDurationMs,
              request_bytes: null,
              response_bytes: null,
              summary: "MCP tool returned an error result.",
            });
            if (inputWorkerId) {
              const inputRecord = input as Record<string, unknown>;
              publishDirectWorker({
                worker_id: inputWorkerId,
                workspace_id: typeof inputRecord.workspace_id === "string" ? inputRecord.workspace_id : undefined,
                status: "FAILED",
                summary: `Failed: ${label}.`,
              });
            } else {
              publishActivity(
                name,
                `Failed: ${label}.`,
                "FAILED",
                { error: activityResultJson },
              );
            }
            emitUsage("error", value);
            return value as never;
          }
          options.traffic?.toolFinished(name, trafficContext, activityDurationMs);
          options.activityTelemetry?.complete({
            client: activityClient,
            sessionId: trafficContext?.sessionId ?? null,
            requestId: trafficContext?.requestId ?? null,
            correlationId: trafficContext?.correlationId ?? null,
            toolName: name,
            title: label,
            summary: `Completed: ${label}.`,
            resultJson: activityResultJson,
            durationMs: activityDurationMs,
          });
          if (workerScoped) {
            publishWorkerResult(input, value, `ChatGPT completed ${label}.`);
          } else {
            publishActivity(
              name,
              `Completed: ${label}.`,
              "COMPLETE",
              { resultJson: activityResultJson },
            );
          }
          emitUsage("complete", value);
          return value as never;
        } catch (error) {
          const activityDurationMs = Date.now() - trafficStartedAt;
          const normalizedErrorCode = normalizeTrafficErrorCode(error);
          if (trafficContext) {
            trafficContext.outcome.failed = true;
            trafficContext.outcome.errorCode = normalizedErrorCode;
          }
          options.traffic?.toolFailed(name, error, trafficContext, activityDurationMs);
          if (!(error instanceof ComputerApiError)) {
            options.diagnostics?.failure({
              request_id: trafficContext?.requestId ?? null,
              correlation_id: trafficContext?.correlationId ?? null,
              session_id: trafficContext?.sessionId ?? null,
              client_id: activityClient.id,
              method: trafficContext?.method ?? null,
              tool_name: name,
              stage: "cptr_mcp",
              error_code: normalizedErrorCode,
              http_status: null,
              retryable: false,
              started_at_ms: trafficStartedAt,
              duration_ms: activityDurationMs,
              request_bytes: null,
              response_bytes: null,
              summary: "MCP tool handler failed.",
            });
          }
          const envelope = error instanceof ComputerApiError
            ? error.toEnvelope()
            : {
                code: "mcp_tool_error",
                message: redactTerminalString(error instanceof Error ? error.message : String(error)),
                retriable: false,
              };
          const activityErrorJson = terminalJson(envelope);
          options.activityTelemetry?.failed({
            client: activityClient,
            sessionId: trafficContext?.sessionId ?? null,
            requestId: trafficContext?.requestId ?? null,
            correlationId: trafficContext?.correlationId ?? null,
            toolName: name,
            title: label,
            summary: `Failed: ${label}.`,
            errorJson: activityErrorJson,
            durationMs: activityDurationMs,
          });
          if (inputWorkerId) {
            const inputRecord = input as Record<string, unknown>;
            publishDirectWorker({
              worker_id: inputWorkerId,
              workspace_id: typeof inputRecord.workspace_id === "string" ? inputRecord.workspace_id : undefined,
              status: "FAILED",
              summary: `Failed: ${label}.`,
            });
          } else {
            publishActivity(
              name,
              `Failed: ${label}.`,
              "FAILED",
              { error: activityErrorJson },
            );
          }
          const errorResult = {
            isError: true,
            content: [{ type: "text" as const, text: JSON.stringify(envelope) }],
          };
          emitUsage("error", errorResult);
          return errorResult as never;
        }
      }) as never,
    );
  }) as typeof server.registerTool;

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
    presentation?: Record<string, unknown>,
  ) => {
    if (liveTerminalStreamingEnabled) {
      const live = tickets.issue(target);
      promptSessions.append(currentPromptTicket(), {
        type: "live.bind",
        payload: { live },
      });
    }
    return {
      ...result(value),
      ...(presentation ? { _meta: { ui: { presentation } } } : {}),
    };
  };

  const recentLiveEvents = async (
    targetType: "task" | "monitor" | "command",
    targetId: string,
    workspaceId?: string,
  ): Promise<Array<Record<string, unknown>>> => {
    const snapshot = await client.getLiveSnapshot(targetType, targetId, 0, workspaceId);
    const events = Array.isArray(snapshot.events) ? snapshot.events : [];
    return events
      .filter((event): event is Record<string, unknown> => Boolean(event) && typeof event === "object" && !Array.isArray(event))
      .slice(-20);
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
        "Call this first whenever the user explicitly invokes CPTR. Set session_name to the exact current ChatGPT conversation title when the host exposes it; otherwise use a concise prompt-derived Workbench session label and never claim it is the host title. When continuing the same task in a later ChatGPT turn, pass resume_session_id so the existing Live Terminal prompt SSE is renewed and reused rather than replaced. This is the sole CPTR UI-producing tool: it opens exactly one Live Terminal before any target exists. All later task, monitor, command, status, and render/bind calls are data-only and update this existing terminal instead of creating another widget.",
      inputSchema: openWorkbenchSessionSchema,
      outputSchema: {
        session_id: z.string(),
        name: z.string(),
        status: z.string(),
        workspace_id: z.string().nullable(),
        title: z.string(),
        initial_summary: z.string(),
        delegation_allowed: z.boolean(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: openWorkbenchToolMetadata,
    },
    async (input) => {
      const delegationAllowed = input.delegation_authorization === "allow:delegate";
      const preloadedWorkspaces = await client
        .listWorkspaces(false)
        .then((value) => Array.isArray(value.workspaces) ? value.workspaces : [])
        .catch(() => []);
      const session = input.resume_session_id
        ? await client.getWorkbenchSession(input.resume_session_id)
        : await client.createWorkbenchSession({
            ...(input.session_name ? { name: input.session_name } : {}),
            ...(input.workspace_id ? { workspace_id: input.workspace_id } : {}),
          });
      const prompt = input.resume_session_id
        ? promptSessions.resumeWorkbenchSession(session.session_id, { allowDelegate: delegationAllowed })
          ?? promptSessions.open({ allowDelegate: delegationAllowed })
        : promptSessions.open({ allowDelegate: delegationAllowed });
      activePromptTicket = prompt.ticket;
      promptTicketContext.enterWith(prompt.ticket);
      promptSessions.bindWorkbenchSession(prompt.ticket, session.session_id);
      const value = {
        session_id: session.session_id,
        name: session.name,
        status: session.status,
        workspace_id: session.workspace_id,
        title: "CPTR computer activity",
        initial_summary: delegationAllowed
          ? `Workbench Session ${session.session_id} is ready. ChatGPT Direct Coding remains available and the user explicitly enabled Delegated Agent tools for this prompt.`
          : `Workbench Session ${session.session_id} is ready. ChatGPT Direct Coding is enabled; Delegated Agent tools are blocked unless the user prompt includes allow:delegate.`,
        delegation_allowed: delegationAllowed,
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
          "cptr/workspaces": preloadedWorkspaces,
        },
      };
    },
  );

  server.registerTool("cptr_list_models", {
    title: "List CPTR models",
    description: "Discover configured model IDs before starting a task; use the returned default when no model is specified.",
    inputSchema: {}, outputSchema: { models: z.array(z.object({ model_id: z.string(), name: z.string(), default: z.boolean() })) },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, _meta: oauthToolMetadata,
  }, async () => activityResult(await client.listModels(), "cptr_list_models"));
  server.registerTool("cptr_list_tasks", {
    title: "List CPTR tasks", description: "Recover or rebind recent durable delegated tasks by workspace and status. Returns the newest tasks first, bounded by limit.",
    inputSchema: listTasksSchema,
    outputSchema: { tasks: z.array(taskListItemOutputSchema) },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, _meta: oauthToolMetadata,
  }, async (input) => activityResult(await client.listTasks(input), "cptr_list_tasks"));
  server.registerTool("cptr_list_autonomous", {
    title: "List CPTR monitors", description: "Recover active or recent delegated autonomous monitors by workspace/status, including per-scope verification state.",
    inputSchema: listAutonomousSchema,
    outputSchema: { monitors: z.array(z.object(autonomousSummaryOutputSchema)) },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, _meta: oauthToolMetadata,
  }, async (input) => activityResult(await client.listAutonomous(input), "cptr_list_autonomous"));
  server.registerTool("cptr_get_task_events", {
    title: "Get task events", description: "Read the same paginated, redacted durable event stream used by the live gateway for delegated task recovery.",
    inputSchema: taskEventsSchema,
    outputSchema: {
      task_id: z.string(),
      after_sequence: z.number().int().nonnegative(),
      last_sequence: z.number().int().nonnegative(),
      max_events: z.number().int().positive(),
      truncated: z.boolean(),
      events: z.array(liveEventOutputSchema),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, _meta: oauthToolMetadata,
  }, async (input) => activityResult(await client.getTaskEvents(input), "cptr_get_task_events"));
  server.registerTool("cptr_code_read_many_files", {
    title: "Read multiple CPTR files", description: "Read up to ten workspace files in one direct ChatGPT request with a shared character budget; each file includes its full-content SHA-256 for safe follow-up writes.",
    inputSchema: readManyFilesSchema,
    outputSchema: {
      workspace_id: z.string(),
      files: z.array(z.object({
        path: z.string(),
        content: z.string(),
        content_sha256: z.string().regex(/^[a-f0-9]{64}$/),
        truncated: z.boolean(),
        start_line: z.number().int().nonnegative(),
        end_line: z.number().int().nonnegative(),
        total_lines: z.number().int().nonnegative(),
      })),
      total_chars: z.number().int().nonnegative(),
      truncated: z.boolean(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, _meta: oauthToolMetadata,
  }, async (input) => activityResult(await client.readManyFiles(input), "cptr_code_read_many_files"));
  server.registerTool("cptr_code_apply_edits", {
    title: "Apply atomic CPTR edits", description: "Apply up to twenty unambiguous edits atomically with optional stale-file protection.",
    inputSchema: applyEditsSchema, outputSchema: { workspace_id: z.string(), path: z.string(), sha256: z.string(), diff: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }, _meta: oauthToolMetadata,
  }, async (input) => activityResult(await client.applyEdits(input), "cptr_code_apply_edits"));

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
    "cptr_benchmark_start",
    {
      title: "Start a standardized CPTR coding benchmark",
      description:
        "Create an owner-scoped disposable benchmark workspace for the versioned standardized coding suite. The hidden grader stays server-side; use normal ChatGPT Direct Coding tools in the returned workspace, then submit the run for objective grading.",
      inputSchema: benchmarkStartSchema,
      outputSchema: benchmarkRunOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async ({ suite_id }) => activityResult(
      await client.startCodingBenchmark({
        suite_id,
        model_reported: clientModelContext.getStore() ?? null,
      }),
      "cptr_benchmark_start",
      "ChatGPT started a standardized isolated coding benchmark.",
    ),
  );

  server.registerTool(
    "cptr_benchmark_submit",
    {
      title: "Submit a CPTR coding benchmark",
      description:
        "Run the server-owned hidden randomized grader for one owned benchmark run. Submission is idempotent after finalization and the model cannot provide or override its score.",
      inputSchema: benchmarkRunSchema,
      outputSchema: benchmarkRunOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async ({ run_id }) => activityResult(
      await client.submitCodingBenchmark(run_id),
      "cptr_benchmark_submit",
      "ChatGPT submitted a standardized coding benchmark for objective grading.",
    ),
  );

  server.registerTool(
    "cptr_benchmark_get",
    {
      title: "Get a CPTR coding benchmark result",
      description:
        "Read one owned standardized benchmark run and its objective case evidence. Hidden grader inputs are not exposed before grading.",
      inputSchema: benchmarkRunSchema,
      outputSchema: benchmarkRunOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async ({ run_id }) => activityResult(
      await client.getCodingBenchmark(run_id),
      "cptr_benchmark_get",
    ),
  );

  server.registerTool(
    "cptr_benchmark_leaderboard",
    {
      title: "Compare standardized CPTR coding benchmark results",
      description:
        "Return the comparable model leaderboard for one versioned standardized suite. It contains only objectively graded standardized runs and never mixes observed real-work operational scores into the ranking.",
      inputSchema: benchmarkLeaderboardSchema,
      outputSchema: benchmarkLeaderboardOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async ({ suite_id }) => activityResult(
      await client.getCodingBenchmarkLeaderboard(suite_id),
      "cptr_benchmark_leaderboard",
    ),
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
      inputSchema: listWorkspacesSchema,
      outputSchema: {
        workspaces: z.array(z.object({
          workspace_id: z.string(),
          name: z.string(),
          available: z.boolean(),
          last_used_at: z.number().int(),
        })),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: workbenchToolMetadata,
    },
    async ({ include_unavailable }) =>
      initialWorkbenchResult(await client.listWorkspaces(include_unavailable), "cptr_list_workspaces"),
  );

  server.registerTool(
    "cptr_get_workspace",
    {
      title: "Get a CPTR workspace",
      description: "Use this when the user wants details about one CPTR workspace by workspace ID.",
      inputSchema: workspaceIdSchema,
      outputSchema: {
        workspace_id: z.string(),
        name: z.string(),
        available: z.boolean(),
        is_git_repo: z.boolean(),
        dirty_file_count: z.number().int(),
        last_used_at: z.number().int(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async ({ workspace_id }) => activityResult(await client.getWorkspace(workspace_id), "cptr_get_workspace"),
  );

  server.registerTool(
    "cptr_factory_start",
    {
      title: "Start a durable Dark Factory run",
      description: "Start one owner-scoped Dark Factory mission through CPTR's server-authoritative factory runtime. This adapter forwards the bounded mission, acceptance criteria, policy, and budget; it does not implement the factory state machine, trust policy, or Victory logic.",
      inputSchema: factoryStartSchema,
      outputSchema: factoryRunControlOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      _meta: oauthToolMetadata,
    },
    async (input) => activityResult(await client.startFactoryRun(input), "cptr_factory_start"),
  );

  server.registerTool(
    "cptr_factory_status",
    {
      title: "Get Dark Factory run status",
      description: "Read the bounded owner-scoped Dark Factory projection, including current cycle, progress, pending approval, budgets, selected capabilities, and latest gate summary.",
      inputSchema: factoryRunIdSchema,
      outputSchema: factoryStatusOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async ({ run_id }) => activityResult(await client.getFactoryRun(run_id), "cptr_factory_status"),
  );

  server.registerTool(
    "cptr_factory_events",
    {
      title: "Get Dark Factory events",
      description: "Read one bounded cursor-paginated page of redacted durable Dark Factory events. The backend remains the authoritative event and transition source.",
      inputSchema: factoryPageSchema,
      outputSchema: { events: z.array(z.record(z.string(), z.unknown())), ...factoryPageMetadataOutputSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async (input) => activityResult(await client.getFactoryEvents(input), "cptr_factory_events"),
  );

  server.registerTool(
    "cptr_factory_evidence",
    {
      title: "Get Dark Factory evidence",
      description: "Read one bounded cursor-paginated page of redacted machine/user evidence for an owner-scoped Dark Factory run.",
      inputSchema: factoryPageSchema,
      outputSchema: { evidence: z.array(z.record(z.string(), z.unknown())), ...factoryPageMetadataOutputSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async (input) => activityResult(await client.getFactoryEvidence(input), "cptr_factory_evidence"),
  );

  server.registerTool(
    "cptr_factory_message",
    {
      title: "Message a Dark Factory run",
      description: "Append one bounded authenticated user message to a durable Dark Factory run. Messages are advisory input and cannot directly set state, gate, trust, or Victory values.",
      inputSchema: factoryMessageSchema,
      outputSchema: { event: z.record(z.string(), z.unknown()) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async (input) => activityResult(await client.messageFactoryRun(input), "cptr_factory_message"),
  );

  server.registerTool(
    "cptr_factory_pause",
    {
      title: "Pause a Dark Factory run",
      description: "Request the backend state machine to pause an owner-scoped Dark Factory run. Approval-required runs cannot be bypassed through this generic control.",
      inputSchema: factoryControlSchema,
      outputSchema: factoryRunControlOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async (input) => activityResult(await client.pauseFactoryRun(input), "cptr_factory_pause"),
  );

  server.registerTool(
    "cptr_factory_resume",
    {
      title: "Resume a paused Dark Factory run",
      description: "Resume only the backend-persisted resumable state of a paused Dark Factory run. This tool cannot release an approval-required operation.",
      inputSchema: factoryControlSchema,
      outputSchema: factoryRunControlOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      _meta: oauthToolMetadata,
    },
    async (input) => activityResult(await client.resumeFactoryRun(input), "cptr_factory_resume"),
  );

  server.registerTool(
    "cptr_factory_approve",
    {
      title: "Decide a pending Dark Factory approval",
      description: "Approve or deny the exact backend-issued operation envelope for a Dark Factory run. Approval may release a revision-bound external/destructive operation; the backend validates the envelope and policy.",
      inputSchema: factoryApprovalSchema,
      outputSchema: {
        approval: z.record(z.string(), z.unknown()),
        run: z.record(z.string(), z.unknown()),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      _meta: oauthToolMetadata,
    },
    async (input) => activityResult(await client.approveFactoryRun(input), "cptr_factory_approve"),
  );

  server.registerTool(
    "cptr_factory_stop",
    {
      title: "Stop a Dark Factory run",
      description: "Stop an owner-scoped Dark Factory run only after CPTR proves its owned worker execution is quiescent. The backend refuses cancellation completion while commands or worker assignments remain unresolved. Each MCP stop attempt is capped at 15 seconds; use cptr_factory_status and retry by run_id if quiescence needs longer.",
      inputSchema: factoryStopSchema,
      outputSchema: factoryRunControlOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async (input) => activityResult(await client.stopFactoryRun(input), "cptr_factory_stop"),
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
    "cptr_direct_worker_create",
    {
      title: "Create an isolated Direct Coding Worker",
      description:
        "Create a model-free direct-coding execution lane backed by an isolated Git worktree. This never starts an LLM, CPTR agent, Codex, Hermes, or autonomous task. ChatGPT remains the sole reasoner. Create all required workers while the source repository is clean, before worker edits begin.",
      inputSchema: directWorkerCreateSchema,
      outputSchema: directWorkerOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: workbenchToolMetadata,
    },
    async (input) => activityResult(await client.createDirectWorker(input), "cptr_direct_worker_create"),
  );

  server.registerTool(
    "cptr_direct_worker_list",
    {
      title: "List Direct Coding Workers",
      description: "List model-free isolated direct-coding workers for one workspace so ChatGPT can coordinate parallel execution lanes.",
      inputSchema: directWorkerListSchema,
      outputSchema: { workspace_id: z.string(), workers: z.array(z.object(directWorkerOutputSchema)) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: workbenchToolMetadata,
    },
    async ({ workspace_id }) => activityResult(await client.listDirectWorkers(workspace_id), "cptr_direct_worker_list"),
  );

  server.registerTool(
    "cptr_direct_worker_get",
    {
      title: "Get Direct Coding Worker state",
      description: "Read the current model-free worker state, changed files, and active/recent command IDs without streaming raw terminal output.",
      inputSchema: directWorkerGetSchema,
      outputSchema: directWorkerOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: workbenchToolMetadata,
    },
    async (input) => activityResult(await client.getDirectWorker(input), "cptr_direct_worker_get"),
  );

  server.registerTool(
    "cptr_direct_workers_overview",
    {
      title: "Summarize Direct Coding Workers",
      description: "Return one compact coordination snapshot for all isolated Direct Coding Workers in the selected workspace.",
      inputSchema: directWorkersOverviewSchema,
      outputSchema: {
        workspace_id: z.string(),
        workers: z.array(z.object(directWorkerOutputSchema)),
        total: z.number().int().nonnegative(),
        active: z.number().int().nonnegative(),
        ready: z.number().int().nonnegative(),
        integrated: z.number().int().nonnegative(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: workbenchToolMetadata,
    },
    async ({ workspace_id }) => activityResult(await client.directWorkersOverview(workspace_id), "cptr_direct_workers_overview"),
  );

  server.registerTool(
    "cptr_direct_workers_integrate",
    {
      title: "Integrate clean Direct Coding Worker changes",
      description:
        "Mechanically apply non-overlapping worker changes back to the source repository without committing them. CPTR refuses active commands, base-revision drift, and overlapping source changes so ChatGPT can review and resolve conflicts itself.",
      inputSchema: directWorkersIntegrateSchema,
      outputSchema: {
        workspace_id: z.string(),
        integrated: z.array(z.string()),
        conflicts: z.record(z.string(), z.array(z.string())),
        applied_paths: z.record(z.string(), z.array(z.string())),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      _meta: workbenchToolMetadata,
    },
    async (input) => activityResult(await client.integrateDirectWorkers(input), "cptr_direct_workers_integrate"),
  );

  server.registerTool(
    "cptr_direct_worker_close",
    {
      title: "Close an isolated Direct Coding Worker",
      description:
        "Remove an isolated worker worktree after its changes are integrated. Unintegrated changes are preserved by default and can be discarded only when discard_changes=true is explicitly supplied.",
      inputSchema: directWorkerCloseSchema,
      outputSchema: {
        worker_id: z.string(),
        workspace_id: z.string(),
        status: z.string(),
        discarded: z.boolean(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      _meta: workbenchToolMetadata,
    },
    async (input) => activityResult(await client.closeDirectWorker(input), "cptr_direct_worker_close"),
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
      if (input.worker_id) {
        if (workbench_session_id) {
          recordWorkbenchActivity(client, workbench_session_id, {
            event_type: "direct_worker.test.started",
            state: command.status,
            workspace_id: input.workspace_id,
            tool_name: "cptr_workspace_run_test_target",
            summary: `ChatGPT started ${command.target} in Direct Coding Worker ${input.worker_id}.`,
          });
        }
        return activityResult(
          { ...command, workspace_id: input.workspace_id },
          "cptr_workspace_run_test_target",
        );
      }
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
    "cptr_fdx_intelligence",
    {
      title: "FDX Intelligence CLI",
      description:
        "Preferred first repository-intelligence entry point for Direct Coding. Choose the FDX action that best fits the task: capabilities/status, token-optimized read, search/grep, batch, outline/tree/listing, dependency impact, why explanations, evidence/semantic/build intelligence, symbol-aware diff, index status, or verification planning. This is structured read-only intelligence, not a raw shell and not agent delegation. If status is unavailable/degraded or fallback_recommended=true, continue with normal CPTR Direct Coding tools. Use exact cptr_code_read_file output and SHA-256 before editing.",
      inputSchema: fdxIntelligenceSchema,
      outputSchema: {
        workspace_id: z.string(),
        worker_id: z.string().optional(),
        repo_path: z.string().optional(),
        action: z.string(),
        provider: z.string(),
        status: z.enum(["ok", "degraded", "unavailable"]),
        fallback_recommended: z.boolean(),
        truncated: z.boolean().optional(),
        assurance: z.string().optional(),
        error_code: z.string().optional(),
        reason: z.string().optional(),
        retriable: z.boolean().optional(),
        fallback_tools: z.array(z.string()).optional(),
        data: z.unknown().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async (input) => activityResult(await client.runFdxIntelligence(input), "cptr_fdx_intelligence"),
  );

  server.registerTool(
    "cptr_code_list_files",
    {
      title: "List files in an authorized CPTR workspace",
      description:
        "Use this to inspect the selected CPTR workspace before ChatGPT directly edits code. It cannot access paths outside that workspace.",
      inputSchema: codingListSchema,
      outputSchema: {
        workspace_id: z.string(),
        path: z.string(),
        entries: z.array(z.object({
          path: z.string(),
          type: z.enum(["file", "directory"]),
          size: z.number().int().nonnegative(),
        })),
        total: z.number().int().nonnegative(),
        truncated: z.boolean(),
        max_entries: z.number().int().positive(),
        cursor: z.string().nullable(),
      },
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
        content_sha256: z.string().regex(/^[a-f0-9]{64}$/),
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
      outputSchema: {
        workspace_id: z.string(),
        path: z.string(),
        matches: z.array(z.object({
          path: z.string(),
          line: z.number().int().nonnegative(),
          text: z.string(),
          context: z.array(z.string()).optional(),
        })),
        max_results: z.number().int().positive(),
        truncated: z.boolean(),
      },
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
      outputSchema: {
        workspace_id: z.string(),
        path: z.string(),
        bytes_written: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      },
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
        replaced_characters: z.number().int().nonnegative(),
        inserted_characters: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        diff: z.string(),
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
      outputSchema: {
        workspace_id: z.string(),
        path: z.string(),
        type: z.literal("directory"),
        created: z.boolean(),
      },
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
      outputSchema: {
        workspace_id: z.string(),
        source: z.string(),
        destination: z.string(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      },
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
      outputSchema: {
        workspace_id: z.string(),
        path: z.string(),
        deleted: z.boolean(),
        existed: z.boolean(),
      },
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
      inputSchema: gitStatusSchema,
      outputSchema: {
        is_repo: z.boolean(),
        branch: z.string().optional(),
        ahead: z.number().int().nonnegative().optional(),
        behind: z.number().int().nonnegative().optional(),
        files: z.array(z.object({
          path: z.string(),
          status: z.string(),
          staged: z.boolean(),
          unstaged: z.boolean().optional(),
          staged_status: z.string().optional(),
          unstaged_status: z.string().optional(),
          additions: z.number().int().nonnegative().optional(),
          deletions: z.number().int().nonnegative().optional(),
          binary: z.boolean().optional(),
        })),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async (input) => activityResult(await client.getGitStatus(input), "cptr_code_get_git_status"),
  );

  server.registerTool(
    "cptr_code_run_command",
    {
      title: "Run a bounded validation command in an authorized CPTR workspace",
      description:
        "Use this only when the user explicitly asks ChatGPT to run a development or validation command in the selected CPTR workspace. CPTR rejects destructive commands. Commands that might contact external services require explicit user approval through allow_network=true.",
      inputSchema: codingCommandSchema,
      outputSchema: directCommandOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      _meta: workbenchToolMetadata,
    },
    async (input) => {
      const { workbench_session_id, ...commandInput } = input;
      const command = await client.runCodingCommand(commandInput);
      if (input.worker_id) {
        if (workbench_session_id) {
          recordWorkbenchActivity(client, workbench_session_id, {
            event_type: "direct_worker.command.started",
            state: command.status,
            workspace_id: input.workspace_id,
            tool_name: "cptr_code_run_command",
            summary: `ChatGPT started a command in Direct Coding Worker ${input.worker_id}.`,
          });
        }
        return activityResult(
          { ...command, workspace_id: input.workspace_id },
          "cptr_code_run_command",
        );
      }
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
      outputSchema: directCommandOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: workbenchToolMetadata,
    },
    async (input) => {
      const command = await client.getCodingCommand(input);
      if (input.worker_id) {
        return activityResult(
          { ...command, workspace_id: input.workspace_id },
          "cptr_code_get_command",
        );
      }
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
      outputSchema: directCommandOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      _meta: workbenchToolMetadata,
    },
    async (input) => {
      const command = await client.cancelCodingCommand(input);
      if (input.worker_id) {
        return activityResult(
          { ...command, workspace_id: input.workspace_id },
          "cptr_code_cancel_command",
        );
      }
      return workbenchResult(
        { ...command, workspace_id: input.workspace_id },
        { targetType: "command", targetId: input.command_id, workspaceId: input.workspace_id },
        "cptr_code_cancel_command",
      );
    },
  );

  server.registerTool(
    "cptr_code_send_input",
    {
      title: "Send stdin to a running direct-coding command",
      description:
        "Send bounded UTF-8 stdin to a running command. Use PTY mode for interactive shells and terminal applications.",
      inputSchema: codingCommandInputSchema,
      outputSchema: directCommandOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      _meta: workbenchToolMetadata,
    },
    async (input) => {
      const command = await client.sendCodingCommandInput(input);
      return input.worker_id
        ? activityResult({ ...command, workspace_id: input.workspace_id }, "cptr_code_send_input")
        : workbenchResult(
            { ...command, workspace_id: input.workspace_id },
            { targetType: "command", targetId: input.command_id, workspaceId: input.workspace_id },
            "cptr_code_send_input",
          );
    },
  );

  server.registerTool(
    "cptr_code_resize_command",
    {
      title: "Resize a running PTY command",
      description:
        "Resize the rows and columns of a running direct-coding command that was started with pty=true.",
      inputSchema: codingCommandResizeSchema,
      outputSchema: directCommandOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: workbenchToolMetadata,
    },
    async (input) => {
      const command = await client.resizeCodingCommand(input);
      return input.worker_id
        ? activityResult({ ...command, workspace_id: input.workspace_id }, "cptr_code_resize_command")
        : workbenchResult(
            { ...command, workspace_id: input.workspace_id },
            { targetType: "command", targetId: input.command_id, workspaceId: input.workspace_id },
            "cptr_code_resize_command",
          );
    },
  );

  server.registerTool(
    "cptr_code_signal_command",
    {
      title: "Signal a running direct-coding command",
      description:
        "Send interrupt, terminate, or kill to a running command. PTY interrupt behaves like Ctrl+C; termination applies to the owned process tree.",
      inputSchema: codingCommandSignalSchema,
      outputSchema: directCommandOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      _meta: workbenchToolMetadata,
    },
    async (input) => {
      const command = await client.signalCodingCommand(input);
      return input.worker_id
        ? activityResult({ ...command, workspace_id: input.workspace_id }, "cptr_code_signal_command")
        : workbenchResult(
            { ...command, workspace_id: input.workspace_id },
            { targetType: "command", targetId: input.command_id, workspaceId: input.workspace_id },
            "cptr_code_signal_command",
          );
    },
  );

  server.registerTool(
    "cptr_lsp_discover",
    {
      title: "Discover configured language servers",
      description:
        "Discover administrator-configured language servers that are installed for the selected workspace. This never executes project code.",
      inputSchema: lspDiscoverSchema,
      outputSchema: {
        workspace_id: z.string(),
        servers: z.array(z.object({ server_id: z.string(), available: z.boolean(), executable: z.string() })),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async (input) => activityResult(await client.discoverLsp(input), "cptr_lsp_discover"),
  );

  server.registerTool(
    "cptr_lsp_start",
    {
      title: "Start a workspace language server",
      description:
        "Start one administrator-configured LSP server inside the authorized workspace root. CPTR initializes it and returns an owned opaque lsp_id.",
      inputSchema: lspStartSchema,
      outputSchema: {
        workspace_id: z.string(),
        lsp_id: z.string(),
        server_id: z.string(),
        root: z.string(),
        status: z.string(),
        pid: z.number().int(),
        capabilities: z.record(z.string(), z.unknown()),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async (input) => activityResult(await client.startLsp(input), "cptr_lsp_start"),
  );

  server.registerTool(
    "cptr_lsp_request",
    {
      title: "Send a JSON-RPC request to an owned language server",
      description:
        "Send one bounded LSP JSON-RPC request to an owned workspace-scoped language server, including hover, definition, references, symbols, completion, or rename-capability requests supported by that server.",
      inputSchema: lspRequestSchema,
      outputSchema: {
        workspace_id: z.string(),
        lsp_id: z.string(),
        response: z.record(z.string(), z.unknown()),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async (input) => activityResult(await client.requestLsp(input), "cptr_lsp_request"),
  );

  server.registerTool(
    "cptr_lsp_stop",
    {
      title: "Stop an owned workspace language server",
      description:
        "Gracefully shut down and dispose an owned LSP process inside the selected workspace.",
      inputSchema: lspStopSchema,
      outputSchema: {
        workspace_id: z.string(),
        lsp_id: z.string(),
        server_id: z.string(),
        status: z.string(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async (input) => activityResult(await client.stopLsp(input), "cptr_lsp_stop"),
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
    "cptr_user_chrome",
    {
      title: "Control paired user Chrome",
      description:
        "Control a user-approved Chrome extension connection through CPTR without changing the isolated cptr_chrome_browser tool. Use approve_pairing with the exact opaque pairing ID shown by the extension before the user claims it. pairing_code is optional for compatible hosts, but should be omitted when the host blocks OTP-like six-digit values. Start with list_devices, use list_tabs with device_id to inspect sanitized live tabs, or call open_session with only device_id to bind the active tab automatically; an explicit tab_id may still be supplied. Use command for browser actions and transfer_lease for explicit agent/human ownership handoff. When browser work is complete and the agent still owns the lease, MUST transfer_lease from agent to none before the final response unless the user explicitly asked to keep browser control active; this ends the scoped Chrome debugger attachment and removes Chrome's debugging banner. Pairing inputs are redacted from telemetry, mutating commands are fenced by the current lease epoch, and the extension never receives the MCP bearer token.",
      inputSchema: userChromeSchema,
      outputSchema: z.object({}).passthrough(),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      _meta: workbenchToolMetadata,
    },
    async (input) => {
      const result = await client.controlUserChrome(input);
      publishBrowserSurface(input, result);
      return activityResult(
        result,
        "cptr_user_chrome",
        `ChatGPT used paired user Chrome action: ${input.action}.`,
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
      title: "Start an authorized delegated CPTR task",
      description: "Do not use this for ordinary CPTR work: ChatGPT must complete the user's request itself through the ChatGPT Direct Coding tools. This Delegated Agent tool is available only when the current prompt session was explicitly authorized with allow:delegate. model_id may name provider/model or agent:profile/model; when omitted, CPTR may use its configured qualified default only after delegation authorization. Encode write, command, network, and package restrictions in execution_policy.",
      inputSchema: startTaskSchema,
      outputSchema: { id: z.string(), status: z.string(), workspace_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: workbenchToolMetadata,
    },
    async (input) => {
      const { workbench_session_id, ...taskInput } = input;
      const task = await client.startTask({
        ...taskInput,
        prompt: delegatedPrompt(workspaceScopedPrompt(input.prompt)),
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
      title: "Execute an authorized delegated CPTR task",
      description:
        "Do not use this for ordinary CPTR work: ChatGPT must perform the user's request itself through the ChatGPT Direct Coding tools. This Delegated Agent convenience call waits only a short bounded interval (5 seconds by default, 15 seconds maximum). Prefer cptr_start_task for durable work, then resume with task events/status/output rather than holding the MCP request open. It is available only when the current prompt session was explicitly authorized with allow:delegate. model_id may name provider/model or agent:profile/model; when omitted, CPTR may use its configured qualified default only after authorization.",
      inputSchema: executeTaskSchema,
      outputSchema: {
        task_id: z.string(),
        workspace_id: z.string(),
        status: z.string(),
        output: z.string(),
        output_truncated: z.boolean(),
        error: z.string().nullable().optional(),
        completion_integrity: z.record(z.string(), z.unknown()).optional(),
        review_summary: z.record(z.string(), z.unknown()).nullable().optional(),
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
        prompt: delegatedPrompt(workspaceScopedPrompt(input.prompt)),
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
      title: "Start an authorized autonomous CPTR delegation",
      description: "Do not use this for ordinary CPTR work: ChatGPT must carry out the user's task through the ChatGPT Direct Coding tools. This Delegated Agent tool is available only when the current prompt session was explicitly authorized with allow:delegate and requires the selected qualified model/profile. Delegated workers inherit the server-enforced execution_policy limits.",
      inputSchema: monitorAutonomousSchema,
      outputSchema: autonomousSummaryOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: workbenchToolMetadata,
    },
    async (input) => {
      const { workbench_session_id, ...monitorInput } = input;
      const monitor = await client.createAutonomous({
        ...monitorInput,
        goal: delegatedPrompt(input.goal),
      });
      const monitorId = String(monitor.monitor_id ?? monitor.goal_id ?? "");
      if (!monitorId) {
        throw new ComputerApiError(
          502,
          "CPTR autonomous creation returned no monitor identity",
          "monitor_identity_missing",
          true,
          "monitor_id",
        );
      }
      const normalizedMonitor = { ...monitor, monitor_id: monitorId };
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
      return workbenchResult(
        normalizedMonitor,
        { targetType: "monitor", targetId: monitorId },
        "cptr_monitor_autonomous",
      );
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
        presentation: z.record(z.string(), z.unknown()).optional().describe(
          "Optional Apps SDK presentation preferences. They do not change CPTR permissions and are forwarded only in result _meta.ui.presentation.",
        ),
      }),
      outputSchema: {
        target_type: z.enum(["task", "monitor", "command"]),
        target_id: z.string(),
        status: z.string(),
        workspace_id: z.string().optional(),
        review_status: z.string().optional(),
        title: z.string(),
        initial_summary: z.string(),
        recent_events: z.array(z.record(z.string(), z.unknown())),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: workbenchToolMetadata,
    },
    async ({ target_type, target_id, workspace_id, workbench_session_id, presentation }) => {
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
        const [task, recent_events] = await Promise.all([
          client.getTask(target_id),
          recentLiveEvents("task", target_id),
        ]);
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
            recent_events,
          },
          { targetType: target_type, targetId: target_id },
          "cptr_render_live_terminal",
          presentation,
        );
      }
      if (target_type === "command") {
        if (!workspace_id) throw new Error("workspace_id is required for a command live terminal");
        const [command, recent_events] = await Promise.all([
          client.getCodingCommand({
            workspace_id,
            command_id: target_id,
            offset: 0,
            wait_seconds: 0,
          }),
          recentLiveEvents("command", target_id, workspace_id),
        ]);
        await bindSession(workspace_id);
        return workbenchResult(
          {
            target_type,
            target_id,
            status: command.status,
            workspace_id,
            title: "CPTR command activity",
            initial_summary: `Command ${target_id} is ${command.status}.`,
            recent_events,
          },
          { targetType: "command", targetId: target_id, workspaceId: workspace_id },
          "cptr_render_live_terminal",
          presentation,
        );
      }
      const [monitor, recent_events] = await Promise.all([
        client.getAutonomous(target_id),
        recentLiveEvents("monitor", target_id),
      ]);
      const status = String(monitor.status ?? "UNKNOWN");
      await bindSession(workspace_id);
      return workbenchResult(
        {
          target_type,
          target_id,
          status,
          title: "CPTR autonomous monitor",
          initial_summary: `Monitor ${target_id} is ${status}.`,
          recent_events,
        },
        { targetType: target_type, targetId: target_id },
        "cptr_render_live_terminal",
        presentation,
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
      description: "Read a paginated, redacted durable event stream for one autonomous monitor. Use after_sequence and max_events to resume without replaying the full history.",
      inputSchema: autonomousEventsSchema,
      outputSchema: {
        monitor_id: z.string(),
        after_sequence: z.number().int().nonnegative(),
        last_sequence: z.number().int().nonnegative(),
        max_events: z.number().int().positive(),
        truncated: z.boolean(),
        events: z.array(liveEventOutputSchema),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async (input) => activityResult(await client.getAutonomousEvents(input), "cptr_get_autonomous_events"),
  );

  server.registerTool(
    "cptr_get_autonomous_evidence",
    {
      title: "Get CPTR autonomous evidence",
      description: "Read persisted worker and independent verification evidence for one autonomous monitor, optionally filtered to a single scope_id.",
      inputSchema: autonomousEvidenceSchema,
      outputSchema: {
        monitor_id: z.string(),
        evidence: z.array(z.object({
          evidence_id: z.string(),
          scope_id: z.string().nullable(),
          kind: z.string(),
          payload: z.record(z.string(), z.unknown()),
          created_at: z.number().int(),
        })),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async (input) => activityResult(await client.getAutonomousEvidence(input), "cptr_get_autonomous_evidence"),
  );

  server.registerTool(
    "cptr_steer_autonomous",
    {
      title: "Steer a CPTR autonomous monitor",
      description: "Send a scoped follow-up message to a running autonomous monitor. The response confirms whether the durable steering request was accepted and reports its current delivery status.",
      inputSchema: steerAutonomousSchema,
      outputSchema: {
        message_id: z.string(),
        status: z.string(),
        accepted: z.boolean(),
        task_id: z.string().optional(),
        control_message_id: z.string().optional(),
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
      outputSchema: { ...autonomousSummaryOutputSchema, quiesced: z.boolean() },
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
    async ({ monitor_id, approval_id, approved, note }) =>
      activityResult(await client.approveAutonomous(monitor_id, approval_id, approved, note), "cptr_approve_autonomous"),
  );

  server.registerTool(
    "cptr_get_task",
    {
      title: "Get CPTR task status",
      description: "Read the durable task state, timestamps, review status, and terminal error for one delegated CPTR task.",
      inputSchema: taskIdSchema,
      outputSchema: {
        id: z.string(),
        workspace_id: z.string(),
        chat_id: z.string(),
        message_id: z.string(),
        status: z.string(),
        prompt: z.string(),
        model_id: z.string(),
        output: z.string(),
        error: z.string().nullable(),
        review_status: z.string(),
        review: z.record(z.string(), z.unknown()),
        created_at: z.number().int(),
        updated_at: z.number().int(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async ({ task_id }) => activityResult(await client.getTask(task_id), "cptr_get_task"),
  );

  server.registerTool(
    "cptr_get_task_output",
    {
      title: "Get CPTR task output",
      description: "Read a bounded page of durable task output. Use offset/max_chars to resume without returning unbounded content.",
      inputSchema: taskOutputSchema,
      outputSchema: {
        task_id: z.string(),
        status: z.string(),
        content: z.string(),
        offset: z.number().int(),
        max_chars: z.number().int(),
        total_chars: z.number().int(),
        truncated: z.boolean(),
        completion_integrity: z.record(z.string(), z.unknown()).nullable().optional(),
        review: z.record(z.string(), z.unknown()).nullable().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async (input) => activityResult(await client.getTaskOutput(input), "cptr_get_task_output"),
  );

  server.registerTool(
    "cptr_get_task_review",
    {
      title: "Get a CPTR task review",
      description:
        "Retrieve the durable review state and a bounded authorized workspace diff for one delegated task. max_diff_bytes prevents an oversized review payload; omitted files are marked in the diff result.",
      inputSchema: taskReviewSchema,
      outputSchema: {
        task_id: z.string(),
        workspace_id: z.string(),
        status: z.string(),
        review: z.record(z.string(), z.unknown()),
        diff: z.object({
          files: z.array(z.record(z.string(), z.unknown())),
          max_bytes: z.number().int(),
          bytes_returned: z.number().int(),
          truncated: z.boolean(),
          omitted_paths: z.array(z.string()),
        }).passthrough(),
        review_available: z.boolean(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async (input) => activityResult(await client.getTaskReview(input), "cptr_get_task_review"),
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
        follow_up_task_id: z.string().optional(),
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
      outputSchema: {
        task_id: z.string(),
        message_id: z.string(),
        status: z.string(),
        accepted: z.boolean(),
        control_message_id: z.string().optional(),
        delivery_status: z.string().optional(),
      },
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
      outputSchema: { id: z.string(), status: z.string(), quiesced: z.boolean() },
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
      inputSchema: gitDiffSchema,
      outputSchema: {
        is_repo: z.boolean(),
        files: z.array(z.record(z.string(), z.unknown())),
        max_bytes: z.number().int(),
        bytes_returned: z.number().int(),
        truncated: z.boolean(),
        omitted_paths: z.array(z.string()),
        diagnostic: z.string().optional(),
        error: z.string().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMetadata,
    },
    async (input) => activityResult(await client.getDiff(input), "cptr_get_diff"),
  );

  const surfaceProfile: McpToolSurfaceProfile = {
    registered_tools: registeredToolCount,
    direct_tools: registeredToolCount - delegatedToolCount,
    delegated_tools: delegatedToolCount,
    registration_ms: Math.max(0, performance.now() - registrationStartedAt),
    budget: MCP_REGISTERED_TOOL_BUDGET,
  };
  if (surfaceProfile.registered_tools > MCP_REGISTERED_TOOL_BUDGET) {
    throw new Error(
      `MCP tool surface budget exceeded: ${surfaceProfile.registered_tools}/${MCP_REGISTERED_TOOL_BUDGET}`,
    );
  }
  toolSurfaceProfiles.set(server, surfaceProfile);
  return server;
}
