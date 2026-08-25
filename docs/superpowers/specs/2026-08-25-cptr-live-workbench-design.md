# CPTR Live Workbench Design

## Classification

This is an architectural `interactive-decoupled` React widget. The existing
plugin is a tool-only TypeScript MCP adapter; the work adds a portable MCP Apps
resource, a scoped realtime gateway, and a mounted workbench that remains alive
while the CPTR task or autonomous monitor continues server-side.

## Goals and non-goals

The workbench must show authoritative CPTR activity in ChatGPT inline UI:
task/agent state, safe shell output, tool calls and bounded results, file
changes, verification/evidence, approvals, steering delivery, cancellation,
and terminal state. Stop and Steer controls must call the existing MCP tools
and retain their current authorization, approval, cancellation, and
exactly-once semantics.

The work does not replace the CPTR worker engine, expose the Control API, add a
browser window, add normal status polling, change the 15-tool surface, expose
chain-of-thought, or deploy/push/merge this feature.

## Chosen architecture

### CPTR authoritative event journal and stream

`computer` owns the canonical event envelope and emits events at the existing
AgentService/chat-task/supervisor boundaries. A new durable, bounded event
journal stores sanitized events for reconnect replay. A process-local fanout
hub wakes active subscribers without making the event stream the source of
truth. The stream endpoint authenticates with the existing scoped Control API
bearer, verifies task/monitor ownership, sends an initial authoritative
snapshot, replays events after `Last-Event-ID`/sequence, then forwards live
events as SSE with heartbeats and bounded backpressure.

The normalized envelope is:

```json
{
  "event_id": "evt_...",
  "sequence": 42,
  "timestamp": "2026-08-25T00:00:00.000Z",
  "task_id": "task_...",
  "monitor_id": "mon_...",
  "worker_task_id": "task_...",
  "type": "tool.output",
  "payload": {}
}
```

The journal is keyed by the logical stream target (`task:<id>` or
`monitor:<id>`), uses a per-target monotonic sequence, caps payload and event
retention, and never records secrets, auth headers, cookies, or raw reasoning.
Events that cannot safely be mapped to the target are omitted from the live
stream rather than guessed.

### Plugin scoped stream gateway

`chatgpt-computer-plugin` issues a short-lived opaque stream ticket only in
widget-only tool-result metadata. The ticket is bound to one target, expires
quickly, and is never placed in `structuredContent`, text content, URLs,
query parameters, logs, or Git. The public gateway validates the ticket,
forwards the request to CPTR using the server-side CPTR credential, preserves
the replay cursor, and streams only sanitized SSE data. CPTR remains private.

The existing `cptr_start_task` and `cptr_monitor_autonomous` tools gain UI
resource metadata and return a concise snapshot plus hidden stream metadata.
The 15 registered tool names and their annotations remain unchanged. The
widget calls existing control tools through the MCP Apps `tools/call` bridge,
so no browser-visible CPTR token is needed.

### Widget

The widget is a single React mount compiled as one browser module and served
from an MCP Apps resource with `text/html;profile=mcp-app`. It uses the
portable `ui/initialize`, `ui/notifications/tool-result`, and `tools/call`
JSON-RPC bridge first. `window.openai` is feature-detected only for optional
fullscreen/PiP, intrinsic-height, theme, and widget-state conveniences.

State is split into authoritative snapshot/event state and ephemeral UI state:
selected tab, expanded event, draft steering text, display mode, and reconnect
status stay in the widget; task/monitor state stays in CPTR. Events are reduced
by `(target, sequence)` so duplicate replay cannot duplicate rows or side
effects. The widget mounts once per logical invocation and updates in place.

The UI states are `CONNECTING`, `RUNNING`, `RECONNECTING`,
`APPROVAL_REQUIRED`, `BLOCKED`, `FAILED`, `CANCELLING`, `CANCELLED`,
`COMPLETE`, and `STREAM_DISCONNECTED`. Tabs are Activity, Terminal, Tools,
Changes, and Evidence. Terminal and tool output use bounded ring buffers and
plain text rendering; no raw reasoning is rendered.

## Event mapping

The computer-side mapper uses existing signals:

- task creation, continuation, cancellation, failure, and completion;
- safe agent-visible output deltas;
- `AgentToolUpdate` as `tool.started`/`tool.completed`;
- `AgentToolOutputDelta` as bounded `shell.stdout`/`shell.stderr` or
  `tool.output` based on stream kind;
- control enqueue, delivery, consumption, effect observation, and invalidation;
- monitor/scope lifecycle changes;
- persisted verification/evidence and approval transitions;
- file/diff summaries derived from existing bounded verification helpers.

Reasoning deltas are not published. The UI receives evidence and user-visible
activity only.

## Failure and lifecycle rules

- A stream disconnect never cancels the CPTR task or monitor.
- Reconnect sends the last received sequence and applies only newer events.
- A stale or expired ticket returns a bounded 401/404 without revealing target
  existence beyond the authenticated CPTR ownership boundary.
- A slow client receives bounded output; the gateway closes with an explicit
  stream error instead of unbounded memory growth.
- A terminal event closes the stream after the event is flushed; historical
  terminal streams do not start a new worker or retry loop.
- Stop/Steer failures are surfaced as control errors and never presented as a
  successful state transition.

## Validation gates

TDD starts with failing tests for the CPTR envelope/journal/replay contract,
plugin ticket ownership/expiry and SSE forwarding, MCP resource metadata, and
widget reducer/bridge behavior. Then run the current CPTR suite, plugin
test/typecheck/build/audit, a local authenticated stream smoke, a standalone
rendered widget smoke, and an end-to-end disposable CPTR task/monitor stream.
Final ChatGPT Developer Mode validation is explicitly not claimed until a real
ChatGPT-native invocation renders the widget and exercises a live task.
