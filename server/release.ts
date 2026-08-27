import { CPTR_APP_VERSION } from "./version.js";

export const MCP_CONTRACT_VERSION = CPTR_APP_VERSION;
export const MCP_CONTRACT_TOOL_COUNT = 56;
export const CPTR_PLUGIN_VERSION = CPTR_APP_VERSION;
export const CPTR_PLUGIN_SCHEMA_REVISION = CPTR_APP_VERSION;

export type PluginUpdateManifest = {
  product: string;
  version: string;
  schema_revision: string;
  contract_version: string;
  tool_count: number;
  release_sha: string | null;
  released_at: string;
  summary: string;
  changes: string[];
  refresh_required: boolean;
  refresh_reason: string;
  refresh_path: string[];
  verification: {
    tool: string;
    arguments: Record<string, unknown>;
  };
};

export function currentPluginUpdateManifest(env: NodeJS.ProcessEnv = process.env): PluginUpdateManifest {
  return {
    product: "CPTR Computer",
    version: CPTR_PLUGIN_VERSION,
    schema_revision: CPTR_PLUGIN_SCHEMA_REVISION,
    contract_version: MCP_CONTRACT_VERSION,
    tool_count: MCP_CONTRACT_TOOL_COUNT,
    release_sha: env.GIT_COMMIT_SHA ?? env.RAILWAY_GIT_COMMIT_SHA ?? env.CPTR_WORKBENCH_BUILD_ID ?? null,
    released_at: "2026-08-27",
    summary: "Unifies CPTR Computer release metadata while adding durable Workbench Sessions and bounded owner-scoped workspace tooling to the Plugin console.",
    changes: [
      `Sets CPTR Computer ${CPTR_APP_VERSION} as the canonical release line matching the version currently shown by ChatGPT.`,
      "Derives MCP serverInfo, contract version, Update Center, health metadata, deployment checks, and Workbench client metadata from package.json instead of independent version literals.",
      "Adds a stable cptr_plugin_update action and same-origin release manifest for update status, release notes, and server-contract verification.",
      "Shows Update available, release notes, refresh instructions, and post-refresh verification inside the existing single Live Terminal card.",
      "Emits MCP tools/list_changed notifications for connected stateful MCP sessions after initialization while keeping ChatGPT's native Refresh/review step authoritative.",
      "Adds durable owner-scoped Workbench Session lifecycle and target-binding tools with bounded redacted event replay.",
      "Adds static workspace inspection plus fixed-profile local test execution without granting unrestricted host or shell access.",
    ],
    refresh_required: true,
    refresh_reason: "This release changes the MCP action schema. ChatGPT must refresh its frozen action snapshot before the new action can be used natively.",
    refresh_path: ["Settings", "Apps / Plugins", "CPTR Computer", "Manage / Action control", "Refresh"],
    verification: {
      tool: "cptr_plugin_update",
      arguments: { action: "status" },
    },
  };
}
