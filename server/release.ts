import { CPTR_APP_VERSION } from "./version.js";

export const MCP_CONTRACT_VERSION = CPTR_APP_VERSION;
export const MCP_CONTRACT_TOOL_COUNT = 63;
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
    released_at: "2026-08-28",
    summary: "CPTR Computer v1.2.0 introduces ChatGPT-native parallel Direct Coding Workers and FDX-first repository intelligence, delivering faster isolated execution, clearer multi-worker visibility, and safer integration without delegating reasoning away from ChatGPT.",
    changes: [
      `Releases CPTR Computer ${CPTR_APP_VERSION} with 63 core control tools and 69 total registered MCP actions including FDX, browser, SSH, and update auxiliaries.`,
      "Adds six model-free Direct Coding Worker lifecycle actions and optional worker targeting across direct file, workspace-intelligence, Git, test, and command tools.",
      "Adds one structured cptr_fdx_intelligence action as the preferred first repository-intelligence entry point, with native FDX protocol negotiation, persistent daemon reuse, worker-aware worktree binding, bounded/redacted output, and normal CPTR fallback semantics.",
      "Runs worker commands without raw live-terminal binding; lightweight worker activity remains visible while terminal tails are loaded only on demand.",
      "Adds a single Workbench worker dashboard with compact lanes and Activity, Changes, and Terminal detail tabs.",
      "Preserves durable owner-scoped Workbench Session lifecycle, target binding, bounded event replay, static workspace inspection, project/test discovery, release readiness, and fixed-profile local test execution.",
      "Makes ChatGPT Direct Coding the default tool group and blocks CPTR/model/profile delegation unless the prompt session is explicitly authorized with allow:delegate.",
      "Adds workspace/model caching, task and monitor recovery lists, task events, batched file reads, atomic multi-edits, SHA-256 preconditions, bounded diffs, and typed error envelopes.",
      "Uses authenticated SSE as the primary delegated-task terminal detector and exposes bounded review, command tail, timeout, truncation, idempotency, and quiescence state.",
      "Keeps the single Live Workbench terminal while preloading safe workspace summaries and forwarding bounded recent redacted events and presentation metadata.",
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
