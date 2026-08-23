# ChatGPT Computer Plugin

Thin MCP adapter for `heidi-dang/computer`. CPTR remains responsible for execution, persistence, authentication, autonomous supervision, verification, retries, approvals, and restart recovery. This repository only exposes the ChatGPT-facing MCP tools and forwards scoped requests to CPTR's `/api/control/v1` API.

The first pass intentionally has no widget. The MCP connection may end while CPTR continues the server-side autonomous monitor.

## Setup

```bash
npm install
cp .env.example .env
```

Set `CPTR_BASE_URL` to the CPTR origin and `CPTR_API_TOKEN` to a scoped CPTR bearer token. The token must be authorized by CPTR; the plugin is not trusted merely because ChatGPT called it.

```bash
npm run build
npm test
npm run typecheck
npm run dev
```

The MCP endpoint is `http://${HOST}:${PORT}/mcp` and health is `/health`.

## Tools

The adapter provides `cptr_list_workspaces`, `cptr_get_workspace`, `cptr_start_task`, `cptr_monitor_autonomous`, `cptr_get_task`, `cptr_get_task_output`, `cptr_send_message`, `cptr_cancel_task`, and `cptr_get_diff`. `cptr_monitor_autonomous` starts or resumes a durable CPTR supervisor; it does not keep an endless polling loop in MCP.

Tool schemas are bounded with Zod and each tool declares read/write/destructive annotations. Annotations guide client behavior but do not replace CPTR authentication or authorization.

## Official MCP shape

This server follows the current OpenAI Apps SDK guidance: the official TypeScript MCP SDK, Streamable HTTP at `/mcp`, explicit input/output schemas, and tool annotations. The closest official no-widget-compatible example is the Node MCP Apps server in `openai/openai-apps-sdk-examples`; this project does not register UI resources in the initial pass.

For local inspection, run `npx @modelcontextprotocol/inspector@latest`, select Streamable HTTP, and enter the configured `/mcp` URL. In ChatGPT Developer Mode, expose the endpoint through an HTTPS tunnel or deployment, add the `/mcp` URL as a connector, and refresh the connector after tool/schema changes.

## Security and limitations

- The CPTR token is read from the environment and is never returned in tool results or normalized errors.
- CPTR enforces workspace ownership and scopes such as `workspace:read`, `task:read`, `task:write`, `autonomous:run`, and `git:read`.
- This adapter does not grant `git:write` or `deploy:write`.
- No widget is included yet.
- CPTR inherits its host-level security model; do not expose it to untrusted users without an appropriate authentication and network boundary.
