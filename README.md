# ChatGPT Computer Plugin

Thin MCP adapter for `heidi-dang/computer`. CPTR remains responsible for execution, persistence, authentication, autonomous supervision, verification, retries, approvals, and restart recovery. This repository only exposes the ChatGPT-facing MCP tools and forwards scoped requests to CPTR's `/api/control/v1` API.

Task and autonomous creation results hydrate an inline MCP Apps Live Workbench. The widget is a view over CPTR's server-authoritative event stream; it does not run workers or replace the existing MCP tools. The MCP connection may end while CPTR continues the server-side autonomous monitor.

## Setup

```bash
npm install
cp .env.example .env
```

Set `CPTR_BASE_URL` to the CPTR origin and `CPTR_API_TOKEN` to a scoped CPTR bearer token. The CPTR token remains the execution and authorization boundary and is never sent to an MCP client.

For the Cloudflare Access Managed OAuth deployment, set `PUBLIC_ORIGIN`, `MCP_OAUTH_RESOURCE`, `CLOUDFLARE_ACCESS_ISSUER`, `CLOUDFLARE_ACCESS_AUDIENCE`, `CLOUDFLARE_ACCESS_JWKS_URI`, and `MCP_OAUTH_ALLOWED_EMAIL`. The origin validates the signed `Cf-Access-Jwt-Assertion` header for issuer, audience, signature, expiration, not-before, subject, and the configured identity allowlist. `MCP_OAUTH_SCOPES` is an optional space- or comma-separated required-scope list; leave it empty when the selected Access provider does not include a scope claim in its origin assertion.

`MCP_ACCESS_TOKEN` remains an optional operator/rollback bearer for direct trusted smoke tests. It is not the ChatGPT-facing authentication path when Cloudflare OAuth is configured.

```bash
npm run build
npm test
npm run typecheck
npm run dev
```

The MCP endpoint is `http://${HOST}:${PORT}/mcp` and health is `/health`.

The `/mcp` endpoint requires a valid Cloudflare Access assertion in production, or the optional static bearer for trusted operator smoke tests. The public protected-resource metadata endpoint is `/.well-known/oauth-protected-resource`; `/health` remains available for liveness checks.

## Tools

The adapter provides workspace-discovery tools plus eight **direct-coding tools**: `cptr_code_list_files`, `cptr_code_read_file`, `cptr_code_search_files`, `cptr_code_write_file`, `cptr_code_edit_file`, `cptr_code_run_command`, `cptr_code_get_command`, and `cptr_code_cancel_command`. These let the official ChatGPT app independently inspect, edit, test, and iterate inside an authorized CPTR workspace without creating a CPTR task, selecting a CPTR model, or invoking CPTR’s agent loop. The adapter also provides `cptr_start_task`, `cptr_execute_task`, autonomous-monitor tools, task-status tools, and `cptr_get_diff` for the separate CPTR-agent workflow. `cptr_execute_task` starts a scoped CPTR task and waits for at most 60 seconds before returning either its bounded result or the durable task ID for follow-up. `cptr_monitor_autonomous` only creates a durable CPTR supervisor; the dedicated autonomous tools inspect, steer, cancel, and approve it without keeping an endless polling loop in MCP.

Tool schemas are bounded with Zod and each tool declares read/write/destructive annotations. Annotations guide client behavior but do not replace CPTR authentication or authorization.

## Official MCP shape

This server follows the MCP Apps contract: the official TypeScript MCP SDK, Streamable HTTP at `/mcp`, explicit input/output schemas, tool annotations, a `text/html;profile=mcp-app` resource, and hidden result metadata containing the versioned `ui://cptr/live-workbench.html` resource reference. The resource uses the portable `ui/*` postMessage bridge first and feature-detects ChatGPT's optional `window.openai` helpers for display mode and intrinsic sizing.

## CPTR Live Workbench

`cptr_open_live_workbench` is the activation tool for a direct ChatGPT invocation such as `@cptr computer`. It opens the Live Workbench immediately, before a CPTR task exists. Workspace discovery also carries the same UI resource so the terminal stays visible while ChatGPT selects a workspace. The widget renders bounded `ChatGPT → CPTR tool` activity from subsequent MCP result metadata; it then automatically rebinds to the target-bound CPTR stream when `cptr_start_task`, `cptr_execute_task`, or `cptr_monitor_autonomous` returns.

`cptr_start_task`, `cptr_execute_task`, and `cptr_monitor_autonomous` attach target-bound, short-lived widget metadata in result `_meta`; the opaque stream ticket is not placed in visible tool content or a URL. The widget calls the plugin's `/live/stream` gateway with the ticket in an `Authorization` header. The gateway forwards the private CPTR bearer server-side to:

```text
GET /api/control/v1/tasks/{task_id}/stream
GET /api/control/v1/autonomous/{monitor_id}/stream
```

CPTR persists bounded, redacted per-target events with monotonic sequences and sends an initial safe snapshot followed by replayable SSE. The widget reconnects with its last sequence, deduplicates events, and stops on terminal status. Slow streams are disconnected so they can reconnect and replay instead of growing memory without bound. The task and monitor streams intentionally omit prompts, raw output projections, and chain-of-thought from their snapshots; activity events are bounded and redacted before persistence.

The widget provides Activity, Terminal, Tools, Changes, and Evidence views, plus scoped Stop and Steer actions. Stop and Steer call the existing MCP tools and include caller-generated idempotency keys for steering. Plugin-side MCP activity is presentation-only and never replaces CPTR's server-authoritative event stream, durable task state, or backend sequence cursor. CPTR remains authoritative for ownership, cancellation quiescence, approval, steering provenance, and terminal state.

Build the browser module and server bundle with:

```bash
npm run build
```

The build emits an ignored `web/dist/` bundle; the Node server inlines the generated JavaScript and CSS into the registered MCP Apps resource. Both `npm run dev` and `npm start` rebuild that ignored browser bundle before the server starts, preventing a deployment from serving the fallback `CPTR Live Workbench bundle is not built` message. Deployments must start the service through one of those scripts rather than invoking `tsx server/index.ts` directly. Local rendered QA can use a disposable static preview, but a real ChatGPT Developer Mode acceptance run is still required to verify the host's MCP Apps bridge and live CPTR stream end to end.

For local inspection, run `npx @modelcontextprotocol/inspector@latest`, select Streamable HTTP, and enter the configured `/mcp` URL. In ChatGPT Developer Mode, expose the endpoint through an HTTPS tunnel or deployment, add the `/mcp` URL as a connector, and refresh the connector after tool/schema changes.

## Security and limitations

- The CPTR token is read from the environment and is never returned in tool results or normalized errors.
- The direct-coding tools are not CPTR agent delegation. They are scoped CPTR workspace primitives that the official ChatGPT app may chain autonomously: list, read, search, write, exact edit, run command, inspect command output, and cancel command. They require no CPTR `model_id` and no external OpenAI API key.
- Direct coding is confined to the selected owned workspace. It rejects absolute/traversal paths, environment files, binary/oversized reads, ambiguous edits, and destructive commands. A potentially external command requires both explicit user approval through `allow_network=true` and CPTR’s separate `command:external` scope.
- CPTR enforces workspace ownership and scopes such as `workspace:read`, `task:read`, `task:write`, `autonomous:run`, `git:read`, `coding:read`, `coding:write`, and `command:execute`. Existing tokens must be reissued with the three direct-coding scopes before these tools will work; `command:external` is intentionally not included in default newly issued keys.
- This adapter does not grant `git:write` or `deploy:write`.
- External/destructive autonomous assignments pause in CPTR with a durable approval record; the MCP `cptr_approve_autonomous` tool only forwards the scoped decision and cannot bypass CPTR policy.
- The widget is a bounded activity projection and is not a substitute for the durable CPTR APIs or the existing 15-tool surface.
- CPTR inherits its host-level security model; do not expose it to untrusted users without an appropriate authentication and network boundary.
