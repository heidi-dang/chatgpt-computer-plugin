# ChatGPT Computer Plugin

Thin MCP adapter for `heidi-dang/computer`. CPTR remains responsible for execution, persistence, authentication, autonomous supervision, verification, retries, approvals, and restart recovery. This repository only exposes the ChatGPT-facing MCP tools and forwards scoped requests to CPTR's `/api/control/v1` API.

Task and autonomous creation results hydrate an inline MCP Apps Live Workbench. The widget is a view over CPTR's server-authoritative event stream; it does not run workers or replace the existing MCP tools. The MCP connection may end while CPTR continues the server-side autonomous monitor.

## Setup

```bash
npm install
cp .env.example .env
```

Set `CPTR_BASE_URL` to the CPTR origin and `CPTR_API_TOKEN` to a scoped CPTR bearer token. The CPTR token remains the execution and authorization boundary and is never sent to an MCP client.

For the Cloudflare Access Managed OAuth deployment, set `PUBLIC_ORIGIN`, `MCP_ALLOWED_ORIGINS`, `MCP_OAUTH_RESOURCE`, `CLOUDFLARE_ACCESS_ISSUER`, `CLOUDFLARE_ACCESS_AUDIENCE`, `CLOUDFLARE_ACCESS_JWKS_URI`, and `MCP_OAUTH_ALLOWED_EMAIL`. `PUBLIC_ORIGIN` is the public HTTPS origin without a path. `MCP_ALLOWED_ORIGINS` is a comma-separated explicit browser-origin allowlist (for example `https://chatgpt.com`); both settings are required when `NODE_ENV=production`, and the service fails closed if either is omitted. The origin validates the signed `Cf-Access-Jwt-Assertion` header for issuer, audience, signature, expiration, not-before, subject, and the configured identity allowlist. `MCP_OAUTH_SCOPES` is an optional space- or comma-separated required-scope list; leave it empty when the selected Access provider does not include a scope claim in its origin assertion.

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

Release **0.5.0** registers a source-verified **36-tool** MCP contract. The direct workspace surface covers listing, reading, searching, writing, exact editing, directory creation, file move/delete, Git status, and bounded local command start/status/cancel operations. Four dedicated SSH tools — `cptr_ssh_list_hosts`, `cptr_ssh_run_command`, `cptr_ssh_get_command`, and `cptr_ssh_cancel_command` — provide remote execution through literal aliases configured for CPTR's execution identity without weakening the generic command policy. The adapter also provides `cptr_start_task`, `cptr_execute_task`, autonomous-monitor tools, task-status/review tools, `cptr_get_diff`, and the Live Workbench surface. Task and autonomous creation accept an `execution_policy` that CPTR enforces server-side to deny file-write tools, command execution, network-capable tools/external commands, and package installation independently; monitor workers inherit the same policy. Control tasks default to local-only authority (`allow_network: false`, `allow_package_install: false`) unless the caller explicitly opts in. `cptr_execute_task` waits for at most 60 seconds before returning either its bounded result or the durable task ID for follow-up; `cptr_monitor_autonomous` creates a durable supervisor that is inspected and controlled through dedicated tools.

Tool schemas are bounded with Zod and each tool declares read/write/destructive annotations. Annotations guide client behavior but do not replace CPTR authentication or authorization.

## Official MCP shape

This server follows the MCP Apps contract: the official TypeScript MCP SDK, Streamable HTTP at `/mcp`, explicit input/output schemas, tool annotations, a `text/html;profile=mcp-app` resource, and hidden result metadata containing the versioned `ui://cptr/live-workbench.html` resource reference. The Workbench resource publishes `ui.domain` from the configured `PUBLIC_ORIGIN` and uses that same normalized origin as its bounded CSP `connectDomains` value; production configuration must provide a non-loopback HTTPS origin. The resource uses the portable `ui/*` postMessage bridge first and feature-detects ChatGPT's optional `window.openai` helpers for display mode and intrinsic sizing.

## CPTR Live Workbench

`cptr_open_live_workbench` is the activation tool for a direct ChatGPT invocation such as `@cptr computer`. It opens the Live Terminal immediately, before a CPTR task exists. Workspace discovery carries the same UI resource so the terminal remains visible while ChatGPT selects a workspace, and task/monitor/command tool results automatically rebind that surface to the corresponding target-bound CPTR stream.

`cptr_start_task`, `cptr_execute_task`, and `cptr_monitor_autonomous` attach target-bound, short-lived widget metadata in result `_meta`; the opaque stream ticket is not placed in visible tool content or a URL. The widget calls the plugin's `/live/stream` gateway with the ticket in an `Authorization` header. The gateway forwards the private CPTR bearer server-side to:

```text
GET /api/control/v1/tasks/{task_id}/stream
GET /api/control/v1/autonomous/{monitor_id}/stream
```

CPTR persists bounded, redacted per-target events with monotonic sequences and sends an initial safe snapshot followed by replayable SSE. The widget reconnects with its last sequence, deduplicates events, and stops on terminal status. Tickets last 15 minutes, longer than the gateway’s bounded 10-minute stream interval; on an expired ticket the widget requests at most two fresh target-bound tickets and rebinds automatically. Slow streams are disconnected so they can reconnect and replay instead of growing memory without bound. The task and monitor streams intentionally omit prompts, raw output projections, and chain-of-thought from their snapshots; activity events are bounded and redacted before persistence.

The default widget surface is intentionally Live-Terminal-only. It renders genuine redacted terminal lifecycle/output rows, target identity, connection state, and compact Stop/Copy/Pin/Expand controls; Activity/Tools/Changes/Evidence/Review dashboard chrome is not rendered. Evidence, review, steering, Git diff, and other control capabilities remain available through their MCP tools and durable CPTR APIs. The terminal keeps a bounded 2,000-line client transcript, follows new output only while the user is at the bottom, and preserves target/workspace isolation across rebinds.

A ChatGPT MCP Apps widget cannot attach arbitrary DOM directly to ChatGPT's composer or escape its host-managed widget surface. The terminal therefore uses CSS sticky positioning inside its allocated surface, and its user-triggered **Pin** action requests Apps SDK `pip` display mode when the host supports it. The host remains authoritative and may grant a different mode; on mobile, PiP may be coerced to fullscreen. No synthetic overlay is used.

Build the browser module and server bundle with:

```bash
npm run build
```

The build emits an ignored `web/dist/` bundle. Workbench hot reload is enabled by default in both development and production: the MCP Apps resource loads the generated JavaScript and CSS from same-origin, `no-store` asset endpoints and keeps a lightweight SSE reload channel open. The server advertises a build ID derived from the exact JavaScript/CSS bytes (optionally labelled by `CPTR_WORKBENCH_BUILD_ID`, `CPTR_DEV_BUILD_ID`, or a deployment SHA); after a deployment restart an already-open widget reconnects, stores the new build ID, reloads once, and fetches the new cache-busted assets even if ChatGPT reuses cached resource HTML. Set `CPTR_HOT_RELOAD=0` only to opt out and fall back to inline assets. Both `npm run dev` and `npm start` rebuild the browser bundle before the server starts, preventing a deployment from serving the fallback `CPTR Live Workbench bundle is not built` message. Production deployments should run `npm ci && npm run build`, then start the compiled process with `NODE_ENV=production` and `node dist/server/index.js` (or the host’s equivalent process command). Development may use `npm run dev`; avoid invoking `tsx server/index.ts` directly in a deployment because it can bypass the asset build lifecycle. Hot reload updates the running Workbench UI and server-backed behavior without a manual ChatGPT page refresh; MCP tool/schema descriptor changes remain host-cached by ChatGPT and may still require a connector refresh because that cache is outside the widget runtime. Local rendered QA can use a disposable static preview, but a real ChatGPT Developer Mode acceptance run is still required to verify the host's MCP Apps bridge and live CPTR stream end to end.

For local inspection, run `npx @modelcontextprotocol/inspector@latest`, select Streamable HTTP, and enter the configured `/mcp` URL. In ChatGPT Developer Mode, expose the endpoint through an HTTPS tunnel or deployment, add the `/mcp` URL as a connector, and refresh the connector after tool/schema changes. Validate the deployed `/health` response first: it must report `workbench.ready: true`, `mcp_contract.version: "0.5.0"`, `mcp_contract.tool_count: 36`, and the expected release SHA. Then run `npm run check:deployed-contract` to verify the exact 36-tool set and Workbench resource. A connector showing an older tool count after deployment is cached or points at a stale service; refresh or re-add it only after the server itself has passed these checks.

## Security and limitations

- The CPTR token is read from the environment and is never returned in tool results or normalized errors.
- The direct-coding tools are not CPTR agent delegation. They are scoped CPTR workspace primitives that the official ChatGPT app may chain autonomously: list, read, search, write, exact edit, run command, inspect command output, and cancel command. They require no CPTR `model_id` and no external OpenAI API key.
- Direct coding is confined to the selected owned workspace. It rejects absolute/traversal paths, environment files, binary/oversized reads, ambiguous edits, and destructive commands. A potentially external local command requires both explicit user approval through `allow_network=true` and CPTR’s separate `command:external` scope. Raw `ssh`, `scp`, and `rsync` remain forbidden through this generic endpoint even with network approval.
- Dedicated SSH execution requires `command:execute` plus `command:external`, accepts only literal aliases present in the execution identity's `~/.ssh/config`, invokes OpenSSH with an argv-based local process, uses non-interactive `BatchMode`, preserves normal host-key verification and known-host handling, bounds output through CPTR's existing command-session ring, and supports incremental status plus cancellation. SSH config values and private-key material are never returned by the host-discovery tool.
- CPTR enforces workspace ownership and scopes such as `workspace:read`, `task:read`, `task:write`, `autonomous:run`, `git:read`, `coding:read`, `coding:write`, and `command:execute`. Existing tokens must be reissued with the three direct-coding scopes before these tools will work; `command:external` is intentionally not included in default newly issued keys.
- This adapter does not grant `git:write` or `deploy:write`.
- External/destructive autonomous assignments pause in CPTR with a durable approval record; the MCP `cptr_approve_autonomous` tool only forwards the scoped decision and cannot bypass CPTR policy.
- The widget is a bounded live-terminal projection and is not a substitute for the durable CPTR APIs or the complete 36-tool surface.
- Persisted workspaces whose host directories no longer exist are returned with `available: false` and rejected with a generic `workspace is unavailable` response; absolute host paths are redacted before any adapter error reaches ChatGPT.
- Browser CORS is origin-allowlisted through `MCP_ALLOWED_ORIGINS`; wildcard CORS is not used by the MCP or Live Workbench endpoints.
- CPTR inherits its host-level security model; do not expose it to untrusted users without an appropriate authentication and network boundary.
