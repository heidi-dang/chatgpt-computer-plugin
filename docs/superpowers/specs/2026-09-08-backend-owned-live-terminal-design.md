# Backend-Owned Live Terminal Design

## Scope

Move CPTR Live Terminal target selection and live event delivery out of ChatGPT tool orchestration. ChatGPT opens one Workbench UI session and invokes normal CPTR execution tools. The plugin/backend automatically associates resulting commands/tasks/monitors with that Workbench session and the existing widget consumes one durable Workbench stream. `cptr_render_live_terminal` is removed from the normal compact MCP surface and retained only as a compatibility/recovery path during migration.

This design intentionally does not remove `cptr_lsp` or `cptr_memory`; those are a separate compact-surface reduction because they require distinct semantic-context contracts.

## Goals

1. Exactly one Live Workbench widget per prompt/session.
2. No ChatGPT-visible render/bind call is required after command/task/monitor creation.
3. The widget owns transport lifecycle: SSE connect, replay cursor, renewal, reconnect, snapshot recovery, and rendering.
4. CPTR workers/backend publish real execution events into the owning Workbench session automatically.
5. Target identity is event metadata, not a reason to create or switch network transports.
6. Existing authorization, ownership, redaction, replay, restart recovery, and delegated-agent gates remain intact.
7. Legacy/manual rebinding remains available during migration without being part of the compact default surface.

## Non-goals

- Changing command execution semantics or authority.
- Weakening workspace/task/monitor ownership validation.
- Exposing raw secrets, prompts, reasoning, cookies, credentials, or unredacted terminal traffic.
- Merging/deploying the PR as part of implementation without separate authorization.
- Removing LSP or persistent-memory capabilities in this phase.

## Current Problem

Today the widget opens on the prompt Workbench SSE, but execution targets still use per-target live tickets. When a command/task/monitor becomes active, the plugin issues a target ticket and appends `live.bind`; the widget then attaches to that target stream. The public `cptr_render_live_terminal` tool exists to force or refresh this transition.

That leaks UI plumbing into the model-facing MCP contract and creates unnecessary failure/latency modes: missed render calls, stale IDs, duplicate binds, target completion before binding, extra target snapshot reads, and extra MCP round trips.

## Proposed Architecture

### Workbench stream is the single UI transport

The browser/widget connects once to the Workbench prompt stream. It never opens a second target SSE for normal operation.

Every event delivered to the widget carries a normalized target descriptor when applicable:

```json
{
  "type": "command.output",
  "sequence": 184,
  "target": {
    "type": "command",
    "id": "cmd_123",
    "workspace_id": "ws_123"
  },
  "payload": {
    "data": "npm test\n"
  }
}
```

The UI reducer uses target identity only for presentation/grouping/state projection.

### Automatic backend ownership binding

When a CPTR execution endpoint receives an owned `workbench_session_id`, target creation and Workbench association happen server-side in the same request lifecycle:

1. Validate owner/workspace/session.
2. Start or resolve the command/task/monitor.
3. Persist/update the Workbench target projection.
4. Publish a Workbench lifecycle event containing the target identity.
5. Project subsequent authoritative target events into the Workbench event stream.

No model-visible call is required to bind or render the target.

### Event projection

Authoritative execution producers remain the source of truth. The Workbench projection subscribes server-side to those events or mirrors them at publication time. It must not scrape tool responses or infer stdout from model-visible content.

Normalized projected event families include:

- `command.started`
- `command.output`
- `command.completed`
- `command.failed`
- `command.cancelled`
- `task.started`
- `task.progress`
- `task.review`
- `task.completed`
- `task.failed`
- `monitor.started`
- `monitor.progress`
- `monitor.completed`
- browser/SSH/factory activity where those operations already have Workbench ownership

Projection must preserve redaction before persistence or fan-out.

## Plugin Changes

1. Keep `cptr_open_live_workbench` as the only UI-producing tool.
2. Stop issuing normal-path target Live Tickets from `workbenchResult()`.
3. Stop emitting normal-path `live.bind` events.
4. Pass `workbench_session_id` through supported execution calls, but treat it purely as backend routing/observability metadata.
5. Remove `cptr_render_live_terminal` from `COMPACT_PASSTHROUGH_TOOL_NAMES` and compact deployed-contract expectations.
6. Keep legacy registration/manual recovery only on the legacy surface during migration.
7. Simplify the widget to remain on the prompt/Workbench stream and consume target-tagged events directly.
8. Retain snapshot/replay as reconnection recovery, not target-attachment startup.

## Backend Contract Changes

The CPTR backend must make Workbench projection server-authoritative:

- execution start endpoints validate `workbench_session_id` ownership;
- successful target creation atomically/best-effort associates the target with the Workbench session without granting authority;
- live event publication mirrors target events into the Workbench session event stream;
- terminal target completion clears active-target projection without disconnecting/archiving the Workbench;
- stale/archived/deleted Workbench sessions do not receive new projected events;
- inability to publish observability must not silently grant authority or corrupt command execution state.

The plugin should not need to fetch a target snapshot merely to begin rendering it.

## Failure Handling

### Workbench unavailable

Execution remains governed by its normal contract. For operations where Workbench ownership is required for authority (for example a root lease), preserve the existing fail-closed behavior. For ordinary observability-only routing, a Workbench projection failure is reported/telemetrized but must not fabricate execution failure after the command has already started.

### SSE disconnect

The widget reconnects with the Workbench sequence cursor. The Workbench replay endpoint returns all retained events after that cursor. Snapshot recovery is used only when the replay window is insufficient or transport recovery requires it.

### Slow client

Existing bounded queues/backpressure apply. A slow subscriber can be disconnected and reconnect from durable replay rather than causing unbounded server memory growth.

### Restart

Durable Workbench events and command/task persistence are used to reconstruct UI state. The client never relies on an in-memory target ticket to know what it was viewing.

## Security Invariants

- Workbench session and target must have the same authenticated owner.
- Command target also validates workspace ownership.
- `workbench_session_id` is a routing/observability identifier, never an authority token.
- Task/monitor delegated-agent authorization remains prompt/session gated.
- Redaction happens before Workbench event persistence and SSE delivery.
- Existing root/capability leases remain independently enforced.
- Removing `cptr_render_live_terminal` must not broaden any execution capability.

## Compatibility / Migration

Phase 1 keeps target-ticket endpoints and `cptr_render_live_terminal` available on the legacy surface for rollback/recovery while compact mode uses backend-owned projection.

Phase 2, after production qualification shows no target-ticket consumers remain, may delete obsolete target-ticket switching code in a separate cleanup change.

## Verification

Required acceptance checks:

1. Open Workbench once, start a command, receive `command.started/output/completed` in the same Workbench stream without calling `cptr_render_live_terminal`.
2. Same behavior for task and monitor targets when delegated-agent authorization is present.
3. Command output begins streaming before the command completes.
4. Multiple sequential commands reuse one Workbench SSE connection.
5. Multiple overlapping owned targets are distinguishable by target metadata without transport switching.
6. iOS-style background/reconnect resumes from cursor without a render/bind call.
7. Command completion leaves the Workbench open for the next action.
8. Invalid/mismatched Workbench ownership is rejected.
9. No secret/control-sequence regression in terminal redaction.
10. Compact MCP tool list no longer exposes `cptr_render_live_terminal`; legacy compatibility remains tested.
11. Existing plugin test suite, typecheck, build, deployed-contract checks, and affected backend tests pass.
12. Add lifecycle instrumentation to measure command-created → first Workbench terminal event latency before/after; do not claim a percentage improvement without measured evidence.

## Success Criteria

The normal ChatGPT execution path is:

```text
cptr_open_live_workbench
        ↓
normal CPTR tool call
        ↓
backend creates/updates target
        ↓
backend projects authoritative events into Workbench stream
        ↓
existing widget renders automatically
```

There is no model-visible UI render step and no normal-path target-stream switch.
