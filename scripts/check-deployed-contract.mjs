const endpoint = process.env.CPTR_DEPLOYED_MCP_URL?.trim();
const token = process.env.CPTR_DEPLOYED_MCP_TOKEN?.trim();

const expectedTools = [
  "cptr_approve_autonomous",
  "cptr_cancel_autonomous",
  "cptr_cancel_task",
  "cptr_chrome_browser",
  "cptr_code_cancel_command",
  "cptr_code_create_directory",
  "cptr_code_delete_file",
  "cptr_code_edit_file",
  "cptr_code_get_command",
  "cptr_code_get_git_status",
  "cptr_code_list_files",
  "cptr_code_move_file",
  "cptr_code_read_file",
  "cptr_code_run_command",
  "cptr_code_search_files",
  "cptr_code_write_file",
  "cptr_decide_task_review",
  "cptr_execute_task",
  "cptr_get_autonomous",
  "cptr_get_autonomous_events",
  "cptr_get_autonomous_evidence",
  "cptr_get_diff",
  "cptr_get_task",
  "cptr_get_task_output",
  "cptr_get_task_review",
  "cptr_get_workspace",
  "cptr_list_workspaces",
  "cptr_monitor_autonomous",
  "cptr_open_live_workbench",
  "cptr_render_live_terminal",
  "cptr_send_message",
  "cptr_ssh_cancel_command",
  "cptr_ssh_get_command",
  "cptr_ssh_list_hosts",
  "cptr_ssh_run_command",
  "cptr_start_task",
  "cptr_steer_autonomous",
];
const expectedResource = "ui://cptr/live-workbench.html";
const expectedContractVersion = "0.7.0";

if (!endpoint || !token) {
  throw new Error("Set CPTR_DEPLOYED_MCP_URL and CPTR_DEPLOYED_MCP_TOKEN before running the deployed contract check.");
}

let nextId = 1;
async function rpc(method, params) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  if (!response.ok) throw new Error(`${method} failed with HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(`${method} returned ${payload.error.message ?? "an RPC error"}`);
  return payload.result ?? payload;
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
if (health?.workbench?.ready !== true) throw new Error("deployed workbench is not ready");
if (health?.workbench?.hot_reload !== true) throw new Error("deployed workbench hot reload is not enabled");
if (typeof health?.workbench?.build_id !== "string" || health.workbench.build_id.length < 12) {
  throw new Error("deployed workbench build fingerprint is missing");
}
if (health?.mcp_contract?.version !== expectedContractVersion) {
  throw new Error(`MCP contract version drift: expected ${expectedContractVersion}, got ${health?.mcp_contract?.version ?? "missing"}`);
}
if (health?.mcp_contract?.tool_count !== expectedTools.length) {
  throw new Error(`MCP health tool-count drift: expected ${expectedTools.length}, got ${health?.mcp_contract?.tool_count ?? "missing"}`);
}

await rpc("initialize", {
  protocolVersion: "2026-01-26",
  capabilities: {},
  clientInfo: { name: "cptr-deployed-contract-check", version: "0.7.0" },
});
const tools = await rpc("tools/list", {});
exactSet((tools.tools ?? []).map((tool) => tool.name), expectedTools, "tool contract");
const uiTools = (tools.tools ?? [])
  .filter((tool) => tool?._meta?.ui?.resourceUri === expectedResource)
  .map((tool) => tool.name);
if (JSON.stringify(uiTools) !== JSON.stringify(["cptr_open_live_workbench"])) {
  throw new Error(`live-terminal UI ownership drift: expected only cptr_open_live_workbench, got [${uiTools.join(", ") || "none"}]`);
}
const resources = await rpc("resources/list", {});
if (!(resources.resources ?? []).some((resource) => resource.uri === expectedResource)) {
  throw new Error(`resource contract drift: ${expectedResource} is unavailable`);
}
const resourceResult = await rpc("resources/read", { uri: expectedResource });
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
const expectedResourceDomains = health.workbench.hot_reload ? [expectedWidgetDomain] : [];
if (!Array.isArray(resourceDomains) || JSON.stringify(resourceDomains) !== JSON.stringify(expectedResourceDomains)) {
  throw new Error(`resource domain policy drift: expected [${expectedResourceDomains.join(", ")}]`);
}
console.log(`CPTR deployed MCP contract verified: ${expectedTools.length} tools, ${expectedResource}, and widget domain ${expectedWidgetDomain}`);
