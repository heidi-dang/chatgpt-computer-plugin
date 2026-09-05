import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
const backendRoot = process.env.CPTR_BACKEND_REPO?.trim()
  ? resolve(process.env.CPTR_BACKEND_REPO)
  : resolve(pluginRoot, "../computer");
const extensionRoot = process.env.CPTR_EXTENSION_REPO?.trim()
  ? resolve(process.env.CPTR_EXTENSION_REPO)
  : resolve(pluginRoot, "../../chatgpt-chrome-extension");

const contractRelativePath = "contracts/browser-protocol-v1.json";
const sources = [
  ["plugin", resolve(pluginRoot, contractRelativePath)],
  ["backend", resolve(backendRoot, contractRelativePath)],
  ["extension", resolve(extensionRoot, contractRelativePath)],
];

function loadContract(label, path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} browser contract is unreadable at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed?.contract !== "cptr-browser-device" || parsed?.contract_revision !== 1) {
    throw new Error(`${label} browser contract has an unsupported identity/revision`);
  }
  if (!Number.isInteger(parsed?.protocol_version) || parsed.protocol_version < 1) {
    throw new Error(`${label} browser contract has an invalid protocol_version`);
  }
  if (!Array.isArray(parsed?.browser_actions) || !Array.isArray(parsed?.mutating_browser_actions)) {
    throw new Error(`${label} browser contract is missing action arrays`);
  }
  const actions = new Set(parsed.browser_actions);
  if (actions.size !== parsed.browser_actions.length) {
    throw new Error(`${label} browser contract contains duplicate browser actions`);
  }
  for (const action of parsed.mutating_browser_actions) {
    if (!actions.has(action)) throw new Error(`${label} mutating action ${action} is not in browser_actions`);
  }
  return parsed;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

const loaded = sources.map(([label, path]) => [label, path, loadContract(label, path)]);
const baseline = JSON.stringify(canonical(loaded[0][2]));
for (const [label, path, contract] of loaded.slice(1)) {
  if (JSON.stringify(canonical(contract)) !== baseline) {
    throw new Error(`cross-repo browser contract drift: ${label} at ${path} does not exactly match plugin ${contractRelativePath}`);
  }
}

const contract = loaded[0][2];
console.log(
  `Cross-repo browser contract verified: protocol v${contract.protocol_version}, ${contract.browser_actions.length} actions, ${contract.mutating_browser_actions.length} mutating actions across plugin/backend/extension.`,
);
