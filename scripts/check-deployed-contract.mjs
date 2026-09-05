import { readFileSync } from "node:fs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const endpoint = process.env.CPTR_DEPLOYED_MCP_URL?.trim();
const token = process.env.CPTR_DEPLOYED_MCP_TOKEN?.trim();
const expectedReleaseSha = process.env.CPTR_EXPECTED_RELEASE_SHA?.trim();
const packageMetadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const expectedContractVersion = packageMetadata.version;
if (typeof expectedContractVersion !== "string" || !expectedContractVersion.trim()) {
  throw new Error("package.json is missing the canonical CPTR Computer version");
}

const expectedTools = [
  "cptr_approve_autonomous",
  "cptr_archive_workbench_session",
  "cptr_benchmark_get",
  "cptr_benchmark_leaderboard",
  "cptr_benchmark_start",
  "cptr_benchmark_submit",
  "cptr_bind_live_workbench_session",
  "cptr_cancel_autonomous",
  "cptr_cancel_task",
  "cptr_chrome_browser",
  "cptr_user_chrome",
  "cptr_code_apply_edits",
  "cptr_code_cancel_command",
  "cptr_code_create_directory",
  "cptr_code_delete_file",
  "cptr_code_edit_file",
  "cptr_code_get_command",
  "cptr_code_get_git_status",
  "cptr_code_list_files",
  "cptr_code_move_file",
  "cptr_code_read_file",
  "cptr_code_read_many_files",
  "cptr_code_resize_command",
  "cptr_code_run_command",
  "cptr_code_search_files",
  "cptr_code_send_input",
  "cptr_code_signal_command",
  "cptr_code_write_file",
  "cptr_confirm_delete_workbench_session",
  "cptr_decide_task_review",
  "cptr_direct_worker_close",
  "cptr_direct_worker_create",
  "cptr_direct_worker_get",
  "cptr_direct_worker_list",
  "cptr_direct_workers_integrate",
  "cptr_direct_workers_overview",
  "cptr_execute_task",
  "cptr_factory_approve",
  "cptr_factory_events",
  "cptr_factory_evidence",
  "cptr_factory_message",
  "cptr_factory_pause",
  "cptr_factory_resume",
  "cptr_factory_start",
  "cptr_factory_status",
  "cptr_factory_stop",
  "cptr_get_autonomous",
  "cptr_get_autonomous_events",
  "cptr_get_autonomous_evidence",
  "cptr_fdx_intelligence",
  "cptr_get_diff",
  "cptr_get_task",
  "cptr_get_task_events",
  "cptr_get_task_output",
  "cptr_get_task_review",
  "cptr_get_workbench_session",
  "cptr_get_workbench_session_events",
  "cptr_get_workspace",
  "cptr_list_autonomous",
  "cptr_list_models",
  "cptr_list_tasks",
  "cptr_list_workbench_sessions",
  "cptr_list_workspaces",
  "cptr_lsp_discover",
  "cptr_lsp_request",
  "cptr_lsp_start",
  "cptr_lsp_stop",
  "cptr_monitor_autonomous",
  "cptr_open_live_workbench",
  "cptr_plugin_update",
  "cptr_rename_workbench_session",
  "cptr_request_delete_workbench_session",
  "cptr_render_live_terminal",
  "cptr_send_message",
  "cptr_ssh_cancel_command",
  "cptr_ssh_get_command",
  "cptr_ssh_list_hosts",
  "cptr_ssh_run_command",
  "cptr_start_task",
  "cptr_steer_autonomous",
  "cptr_workspace_dependency_summary",
  "cptr_workspace_detect_project",
  "cptr_workspace_discover_tests",
  "cptr_workspace_file_metadata",
  "cptr_workspace_package_scripts",
  "cptr_workspace_read_many",
  "cptr_workspace_release_readiness",
  "cptr_workspace_run_test_target",
  "cptr_workspace_search_symbols",
  "cptr_workspace_tree",
];
const auxiliaryTools = new Set([
  "cptr_plugin_update", "cptr_chrome_browser", "cptr_user_chrome",
  "cptr_ssh_list_hosts", "cptr_ssh_run_command", "cptr_ssh_get_command", "cptr_ssh_cancel_command",
]);
const expectedPlannedTools = expectedTools.filter((name) => !auxiliaryTools.has(name));
const expectedRegisteredToolCount = 90;
const expectedResource = "ui://cptr/live-workbench.html";

if (!endpoint || !token) {
  throw new Error("Set CPTR_DEPLOYED_MCP_URL and CPTR_DEPLOYED_MCP_TOKEN before running the deployed contract check.");
}

function exactSet(actual, expected, label) {
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  if (JSON.stringify(actualSorted) !== JSON.stringify(expectedSorted)) {
    const missing = expectedSorted.filter((name) => !actualSorted.includes(name));
    const unexpected = actualSorted.filter((name) => !expectedSorted.includes(name));
    throw new Error(`${label} drift: missing [${missing.join(", ") || "none"}], unexpected [${unexpected.join(", ") || "none"}]`);
  }
}

const healthUrl = new URL("/health", endpoint);
const healthResponse = await fetch(healthUrl);
if (!healthResponse.ok) throw new Error(`health check failed with HTTP ${healthResponse.status}`);
const health = await healthResponse.json();
if (health?.app_version !== expectedContractVersion) {
  throw new Error(`app version drift: expected ${expectedContractVersion}, got ${health?.app_version ?? "missing"}`);
}
if (expectedReleaseSha && health?.release !== expectedReleaseSha) {
  throw new Error(`release SHA drift: expected ${expectedReleaseSha}, got ${health?.release ?? "missing"}`);
}
if (health?.workbench?.ready !== true) throw new Error("deployed workbench is not ready");
if (health?.workbench && "asset_directory" in health.workbench) {
  throw new Error("health response leaks the internal workbench asset directory");
}
if (health?.workbench && "hot_reload" in health.workbench) {
  throw new Error("health response exposes development-only hot reload state");
}
if (health?.mcp_contract && ("session_mode" in health.mcp_contract || "active_sessions" in health.mcp_contract)) {
  throw new Error("health response exposes internal MCP session details");
}
if (typeof health?.workbench?.build_id !== "string" || health.workbench.build_id.length < 12) {
  throw new Error("deployed workbench build fingerprint is missing");
}
for (const developmentPath of [
  "/__cptr/dev/workbench.js",
  "/__cptr/dev/workbench.css",
  "/__cptr/dev/reload",
]) {
  const response = await fetch(new URL(developmentPath, endpoint), { redirect: "manual" });
  if (response.status !== 404) {
    throw new Error(`development route unexpectedly exposed: ${developmentPath} returned HTTP ${response.status}`);
  }
}
if (health?.mcp_contract?.version !== expectedContractVersion) {
  throw new Error(`MCP contract version drift: expected ${expectedContractVersion}, got ${health?.mcp_contract?.version ?? "missing"}`);
}
if (health?.mcp_contract?.tool_count !== expectedPlannedTools.length) {
  throw new Error(`MCP health planned-tool-count drift: expected ${expectedPlannedTools.length}, got ${health?.mcp_contract?.tool_count ?? "missing"}`);
}

const client = new Client(
  { name: "cptr-deployed-contract-check", version: expectedContractVersion },
  {
    capabilities: {},
    versionNegotiation: { mode: { pin: "2026-07-28" } },
  },
);
const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
  authProvider: { token: async () => token },
});
await client.connect(transport);
if (client.getProtocolEra() !== "modern") {
  throw new Error(`MCP protocol-era drift: expected modern, got ${client.getProtocolEra()}`);
}
if (client.getNegotiatedProtocolVersion() !== "2026-07-28") {
  throw new Error(`MCP protocol-version drift: expected 2026-07-28, got ${client.getNegotiatedProtocolVersion() ?? "missing"}`);
}
const serverInstructions = client.getInstructions() ?? "";
if (!serverInstructions.includes("client_model") || !serverInstructions.includes("current model")) {
  throw new Error("MCP discover instructions do not require current-model self-reporting via client_model");
}
const tools = await client.listTools();
exactSet((tools.tools ?? []).map((tool) => tool.name), expectedTools, "tool contract");
if ((tools.tools ?? []).length !== expectedRegisteredToolCount) {
  throw new Error(`MCP registered-tool-count drift: expected ${expectedRegisteredToolCount}, got ${(tools.tools ?? []).length}`);
}
const toolsMissingClientModel = (tools.tools ?? [])
  .filter((tool) => tool?.inputSchema?.properties?.client_model?.type !== "string")
  .map((tool) => tool.name);
if (toolsMissingClientModel.length > 0) {
  throw new Error(`model-reporting contract drift: client_model missing from [${toolsMissingClientModel.join(", ")}]`);
}
const uiTools = (tools.tools ?? [])
  .filter((tool) => tool?._meta?.ui?.resourceUri === expectedResource)
  .map((tool) => tool.name);
if (JSON.stringify(uiTools) !== JSON.stringify(["cptr_open_live_workbench"])) {
  throw new Error(`live-terminal UI ownership drift: expected only cptr_open_live_workbench, got [${uiTools.join(", ") || "none"}]`);
}
const resources = await client.listResources();
if (!(resources.resources ?? []).some((resource) => resource.uri === expectedResource)) {
  throw new Error(`resource contract drift: ${expectedResource} is unavailable`);
}
const resourceResult = await client.readResource({ uri: expectedResource });
const resource = (resourceResult.contents ?? []).find((content) => content.uri === expectedResource);
if (!resource) throw new Error(`resource contract drift: ${expectedResource} has no readable content`);
if (resource.mimeType !== "text/html;profile=mcp-app") {
  throw new Error(`resource MIME drift: expected text/html;profile=mcp-app, got ${resource.mimeType ?? "missing"}`);
}
const ui = resource._meta?.ui;
const expectedWidgetDomain = process.env.CPTR_DEPLOYED_PUBLIC_ORIGIN?.trim() || new URL(endpoint).origin;
if (ui?.domain !== expectedWidgetDomain) {
  throw new Error(`resource widget domain drift: expected ${expectedWidgetDomain}, got ${ui?.domain ?? "missing"}`);
}
const connectDomains = ui?.csp?.connectDomains;
if (!Array.isArray(connectDomains) || JSON.stringify(connectDomains) !== JSON.stringify([expectedWidgetDomain])) {
  throw new Error(`resource connect-domain drift: expected [${expectedWidgetDomain}]`);
}
const resourceDomains = ui?.csp?.resourceDomains;
const expectedResourceDomains = [];
if (!Array.isArray(resourceDomains) || JSON.stringify(resourceDomains) !== JSON.stringify(expectedResourceDomains)) {
  throw new Error(`resource domain policy drift: expected [${expectedResourceDomains.join(", ")}]`);
}
if (typeof resource.text === "string" && resource.text.includes("/__cptr/dev/")) {
  throw new Error("production Workbench resource references development-only routes");
}
await client.close();
console.log(`CPTR deployed MCP contract verified: MCP 2026-07-28 modern era, ${expectedPlannedTools.length} planned tools, ${expectedRegisteredToolCount} registered actions, current-model reporting on every action, ${expectedResource}, and widget domain ${expectedWidgetDomain}`);
