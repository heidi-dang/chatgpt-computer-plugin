# Backend-Owned Live Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Workbench session the single durable Live Terminal stream so commands/tasks/monitors publish authoritative execution events without a ChatGPT-visible render/bind call.

**Architecture:** The `computer` backend carries `workbench_session_id` into execution ownership, validates it before execution, and mirrors already-redacted authoritative target events into `workbench:{session_id}` in the existing `LiveEventHub`. A new owner-scoped Workbench SSE endpoint stays open across target completion. The plugin opens one Workbench widget, runs one server-side upstream Workbench stream bridge, and stops issuing normal-path target tickets/`live.bind`; compact mode no longer registers `cptr_render_live_terminal`.

**Tech Stack:** Python/FastAPI/SQLAlchemy/asyncio backend; TypeScript/Node MCP adapter; React widget; SSE; Node test runner; pytest.

**Spec:** `docs/superpowers/specs/2026-09-08-backend-owned-live-terminal-design.md`

## Global Constraints

- Exactly one Live Workbench widget per prompt/session.
- `workbench_session_id` is routing/observability metadata, never authority.
- Existing owner/workspace/delegation/root/capability gates remain unchanged.
- Redaction occurs before projected event persistence/fan-out.
- Command completion must not close the Workbench stream.
- Legacy target streams and `cptr_render_live_terminal` remain available only on the legacy surface for rollback/recovery.
- No merge or deployment without separate explicit authorization.

---

### Task 1: Backend Workbench live-event projection

**Files:**
- Modify: `computer/cptr/services/live_events.py`
- Test: `computer/tests/test_live_events.py`

**Interfaces:**
- Produces: `workbench_target_key(session_id: str) -> str`
- Extends: `publish_terminal_event(..., workbench_session_id: str | None = None)` and task/monitor/command publishers with optional Workbench projection.

- [ ] Write a failing test that publishes a redacted `terminal.chunk` with `workbench_session_id` and asserts replay exists under both the command target and `workbench:{session}` with preserved target metadata.
- [ ] Run `python -m pytest tests/test_live_events.py -q` and confirm the new assertion fails because no Workbench projection exists.
- [ ] Implement minimal projection using the existing `LiveEventHub`; do not add a second buffering queue.
- [ ] Add tests proving projection is skipped when no Workbench ID is supplied and terminal redaction remains identical.
- [ ] Run `python -m pytest tests/test_live_events.py -q` and require green.

### Task 2: Backend execution ownership and Workbench SSE

**Files:**
- Modify: `computer/cptr/services/workbench_sessions.py`
- Modify: `computer/cptr/routers/coding.py`
- Modify: `computer/cptr/routers/control.py`
- Modify: `computer/cptr/routers/control_stream.py`
- Modify: `computer/cptr/utils/tools.py`
- Test: `computer/tests/test_workbench_sessions.py`
- Test: `computer/tests/test_direct_coding.py`
- Test: `computer/tests/test_control_stream.py`

**Interfaces:**
- Add active owner validation for an optional Workbench session before command/task/monitor creation.
- Carry `workbench_session_id` in command execution context/session state.
- Add `GET /api/control/v1/workbench-sessions/{session_id}/stream` and `/stream/snapshot` backed by `workbench:{session_id}`.
- Workbench stream uses `stop_on_terminal=False`; individual target streams keep existing terminal-close semantics.

- [ ] Write failing command-route tests: valid Workbench ID is accepted and associated automatically; foreign/missing/archived Workbench IDs are rejected before spawn.
- [ ] Write failing stream test showing two sequential command terminal events can be emitted without closing the Workbench SSE after the first completion.
- [ ] Run focused pytest and verify expected failures.
- [ ] Implement owner validation, command-context propagation, target projection update, and Workbench SSE endpoint.
- [ ] Extend `TaskCreateRequest` and `AutonomousCreateRequest` with optional `workbench_session_id`; bind created task/monitor server-side and pass the ID to their live publishers/monitor loop.
- [ ] Run `python -m pytest tests/test_workbench_sessions.py tests/test_live_events.py tests/test_direct_coding.py tests/test_control_stream.py tests/test_control_api.py -q`.

### Task 3: Plugin ComputerClient Workbench stream

**Files:**
- Modify: `server/client/computer-client.ts`
- Test: `tests/mcp.test.ts` or a focused new Workbench client test.

**Interfaces:**
- Add `getWorkbenchLiveSnapshot(sessionId, afterSequence)`.
- Add `streamWorkbench(sessionId, afterSequence, signal?)`.
- Extend `startTask`, `executeTask`, and `createAutonomous` inputs with optional `workbench_session_id`.

- [ ] Write failing tests for the exact backend URLs, auth headers, cursor propagation, and task/monitor body forwarding.
- [ ] Run the focused Node tests and confirm RED.
- [ ] Implement the minimal client methods and input forwarding.
- [ ] Re-run focused tests and require GREEN.

### Task 4: Server-owned upstream bridge into the existing prompt SSE

**Files:**
- Modify: `server/prompt-terminal.ts`
- Modify: `server/mcp.ts`
- Test: `tests/prompt-terminal.test.ts`
- Test: `tests/stateless-live-binding.test.ts`

**Interfaces:**
- One prompt terminal session owns at most one upstream Workbench stream bridge.
- Bridge parses backend SSE frames and appends normalized target-tagged events to the existing prompt event queue.
- Bridge resumes from backend Workbench cursor after reconnect and stops when the prompt session is removed/superseded.

- [ ] Write failing tests proving an opened Workbench can receive backend command events without `live.bind` and that reconnect resumes from the last backend sequence.
- [ ] Run focused tests and confirm RED.
- [ ] Implement bridge lifecycle with one AbortController per prompt session; no target-ticket creation on the normal path.
- [ ] Start/refresh the bridge from `cptr_open_live_workbench`; execution/status tools only carry `workbench_session_id`.
- [ ] Re-run focused tests and require GREEN.

### Task 5: Widget single-stream reducer and compact-surface cleanup

**Files:**
- Modify: `web/src/workbench.tsx`
- Modify: `web/src/state.ts` only if target normalization requires it.
- Modify: `server/mcp.ts`
- Modify: `scripts/check-deployed-contract.mjs`
- Modify: compact contract tests (`tests/mcp-compact.test.ts`, `tests/mcp.test.ts`, `tests/stateless-live-binding.test.ts`).

**Interfaces:**
- Widget stays on prompt SSE; backend-projected event `target` metadata drives presentation only.
- Compact surface excludes `cptr_render_live_terminal`; legacy surface still registers it.

- [ ] Write failing contract test asserting compact tool list does not contain `cptr_render_live_terminal` while legacy does.
- [ ] Write failing widget/reducer test or prompt-stream integration test showing command output renders from target-tagged Workbench events with no `live.bind`.
- [ ] Run tests and confirm RED.
- [ ] Remove `cptr_render_live_terminal` from compact passthrough/contract expectations; retain legacy registration.
- [ ] Remove normal-path target-ticket/`live.bind` emission from `workbenchResult()` and simplify widget switching logic without removing legacy recovery support.
- [ ] Run focused tests and require GREEN.

### Task 6: Cross-repo verification, instrumentation, and delivery

**Files:**
- Modify docs/release notes only for behavior actually implemented.
- No deployment files unless separately authorized.

- [ ] Add/extend lifecycle timing so command-created → first Workbench projected event is measurable; report measured values only.
- [ ] Backend: run `python -m pytest tests/test_live_events.py tests/test_workbench_sessions.py tests/test_direct_coding.py tests/test_control_stream.py tests/test_control_api.py tests/test_terminal_parity.py -q` and affected type/lint checks available in repo.
- [ ] Plugin: run `npm test`, `npm run typecheck`, `npm run build`, `npm run check:cross-repo-contract`, and `git diff --check`.
- [ ] Confirm compact deployed-contract expected tool count/list is updated consistently and legacy compatibility tests remain green.
- [ ] Inspect both diffs for unrelated changes and security regressions.
- [ ] Commit/push backend branch and open/update its PR; commit/push plugin changes to PR #40.
- [ ] Stop before merge/deploy and report exact revisions, test evidence, remaining authorization boundary.
