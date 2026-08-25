# ChatGPT Computer Plugin

Thin MCP adapter for `heidi-dang/computer`. CPTR remains responsible for execution, persistence, authentication, autonomous supervision, verification, retries, approvals, and restart recovery. This repository only exposes the ChatGPT-facing MCP tools and forwards scoped requests to CPTR's `/api/control/v1` API.

The first pass intentionally has no widget. The MCP connection may end while CPTR continues the server-side autonomous monitor.

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

The adapter provides `cptr_list_workspaces`, `cptr_get_workspace`, `cptr_start_task`, `cptr_monitor_autonomous`, `cptr_get_autonomous`, `cptr_get_autonomous_events`, `cptr_get_autonomous_evidence`, `cptr_steer_autonomous`, `cptr_cancel_autonomous`, `cptr_approve_autonomous`, `cptr_get_task`, `cptr_get_task_output`, `cptr_send_message`, `cptr_cancel_task`, and `cptr_get_diff`. `cptr_monitor_autonomous` only creates a durable CPTR supervisor; the dedicated autonomous tools inspect, steer, cancel, and approve it without keeping an endless polling loop in MCP.

Tool schemas are bounded with Zod and each tool declares read/write/destructive annotations. Annotations guide client behavior but do not replace CPTR authentication or authorization.

## Official MCP shape

This server follows the current OpenAI Apps SDK guidance: the official TypeScript MCP SDK, Streamable HTTP at `/mcp`, explicit input/output schemas, and tool annotations. The closest official no-widget-compatible example is the Node MCP Apps server in `openai/openai-apps-sdk-examples`; this project does not register UI resources in the initial pass.

For local inspection, run `npx @modelcontextprotocol/inspector@latest`, select Streamable HTTP, and enter the configured `/mcp` URL. In ChatGPT Developer Mode, expose the endpoint through an HTTPS tunnel or deployment, add the `/mcp` URL as a connector, and refresh the connector after tool/schema changes.

## Security and limitations

- The CPTR token is read from the environment and is never returned in tool results or normalized errors.
- CPTR enforces workspace ownership and scopes such as `workspace:read`, `task:read`, `task:write`, `autonomous:run`, and `git:read`.
- This adapter does not grant `git:write` or `deploy:write`.
- External/destructive autonomous assignments pause in CPTR with a durable approval record; the MCP `cptr_approve_autonomous` tool only forwards the scoped decision and cannot bypass CPTR policy.
- No widget is included yet.
- CPTR inherits its host-level security model; do not expose it to untrusted users without an appropriate authentication and network boundary.
