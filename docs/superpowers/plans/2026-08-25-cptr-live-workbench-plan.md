# CPTR Live Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a secure inline MCP Apps Live Workbench that renders authoritative CPTR task and monitor activity over replayable SSE without changing the existing 15-tool contract.

**Architecture:** CPTR persists sanitized per-target events and serves an authenticated snapshot/replay/live SSE stream. The plugin issues short-lived target-bound widget tickets, forwards the private CPTR stream through an authenticated gateway, and returns a single React MCP Apps resource that reduces events into Activity, Terminal, Tools, Changes, and Evidence views.

**Tech Stack:** Python/FastAPI/SQLAlchemy/SQLite in `computer`; Node/TypeScript MCP SDK, React 18, React DOM, esbuild, and Node test runner in `chatgpt-computer-plugin`.

**Spec:** `docs/superpowers/specs/2026-08-25-cptr-live-workbench-design.md`

## Global Constraints

- Preserve all 15 MCP tool names, schemas, annotations, OAuth behavior, steering, cancellation, approval, and private Control API boundaries.
- Do not expose CPTR credentials, stream tickets, auth headers, cookies, or raw chain-of-thought in model-visible output, logs, URLs, or Git.
- Do not create a second worker engine or use normal `get_task` polling as the live UI transport.
- Use only bounded disposable fixtures for live integration checks; do not push, deploy, merge, rotate credentials, or modify user browser state.
- Keep widget state separate from authoritative CPTR business state and deduplicate events by target and sequence.

### Task 1: CPTR live event contract and durable journal

**Files:**
- Create: `computer/cptr/services/live_events.py`
- Create: `computer/cptr/migrations/versions/0008_live_events.py`
- Modify: `computer/cptr/models/control.py`
- Test: `computer/tests/test_live_events.py`

**Interfaces:**
- `LiveEventEnvelope.to_dict() -> dict[str, Any]`
- `LiveEventStore.append(...) -> LiveEventEnvelope`
- `LiveEventStore.replay(target_key, after_sequence, limit) -> list[LiveEventEnvelope]`
- `LiveEventHub.subscribe(target_key, after_sequence) -> AsyncIterator[LiveEventEnvelope]`
- `LiveEventHub.publish(...) -> LiveEventEnvelope`

- [ ] Write tests for sanitized envelope fields, per-target monotonic sequences, bounded payloads, replay after a cursor, duplicate subscriber delivery, and terminal events.
- [ ] Run `cd computer && .venv/bin/python -m unittest tests.test_live_events -v` and verify RED because the new module/model does not exist.
- [ ] Add the SQLAlchemy event model, migration, bounded sanitizer, per-target sequence allocation, replay query, and process-local subscriber fanout.
- [ ] Run the focused tests and then the existing computer suite.
- [ ] Commit `feat: add durable CPTR live event journal` on the computer feature branch.

### Task 2: CPTR event publication and authenticated SSE routes

**Files:**
- Create: `computer/cptr/routers/control_stream.py`
- Modify: `computer/cptr/app.py`
- Modify: `computer/cptr/routers/control.py`
- Modify: `computer/cptr/services/agent_service.py`
- Modify: `computer/cptr/utils/chat_task.py`
- Modify: `computer/cptr/services/supervisor.py`
- Test: `computer/tests/test_control_stream.py`

**Interfaces:**
- `GET /api/control/v1/tasks/{task_id}/stream`
- `GET /api/control/v1/autonomous/{monitor_id}/stream`
- `publish_task_event(...)` and `publish_monitor_event(...)` helpers that preserve task/monitor ownership metadata.

- [ ] Write failing API tests for auth, ownership, initial snapshot, `Last-Event-ID` replay, heartbeats, terminal close, and bounded invalid-cursor errors.
- [ ] Run the focused API tests and verify RED.
- [ ] Add stream routes using existing scoped control authentication and `StreamingResponse`; do not reuse the unrelated filesystem/port WebSocket.
- [ ] Emit task/tool/shell/control lifecycle events at existing `AgentService` and `chat_task` boundaries, omit reasoning, and emit supervisor/approval/evidence/file summaries from existing durable operations.
- [ ] Add terminal lifecycle events only after CPTR durable state is finalized and ensure cancellation/completion quiescence is respected.
- [ ] Run focused stream tests, CPTR full suite, targeted Ruff, format check, and `git diff --check`.
- [ ] Commit `feat: expose authenticated CPTR live activity streams`.

### Task 3: Plugin stream tickets and gateway

**Files:**
- Create: `plugin/server/live-gateway.ts`
- Create: `plugin/server/live-tickets.ts`
- Modify: `plugin/server/index.ts`
- Modify: `plugin/server/client/computer-client.ts`
- Test: `plugin/tests/live-gateway.test.ts`

**Interfaces:**
- `LiveTicketStore.issue(target) -> WidgetStreamMetadata`
- `LiveTicketStore.consume/validate(token, target) -> TicketClaims`
- `LiveGateway.handle(req, res) -> Promise<void>`

- [ ] Write failing tests for ticket expiry, target binding, replay-header forwarding, no query-token acceptance, CPTR error normalization, stream byte limits, and secret redaction.
- [ ] Run the focused plugin tests and verify RED.
- [ ] Implement short-lived opaque in-memory tickets bound to a task/monitor target and authenticated MCP request context; issue them only for widget hydration metadata.
- [ ] Add a public gateway route that accepts only `Authorization: Bearer <ticket>`, calls private CPTR with its server-side token, forwards bounded SSE, and closes on terminal/error/backpressure.
- [ ] Run focused plugin tests and typecheck.
- [ ] Commit `feat: add scoped live stream gateway`.

### Task 4: MCP Apps resource and tool hydration metadata

**Files:**
- Create: `plugin/server/ui/workbench-resource.ts`
- Modify: `plugin/server/mcp.ts`
- Modify: `plugin/server/index.ts`
- Test: `plugin/tests/ui-resource.test.ts`

- [ ] Write failing tests that inspect tools/list and tool results for `text/html;profile=mcp-app`, `_meta.ui.resourceUri`, concise structured snapshots, and hidden stream metadata without token leakage in content.
- [ ] Run the focused tests and verify RED.
- [ ] Register one versioned UI resource and attach it to task/monitor creation results without changing tool count or annotations.
- [ ] Keep stream tickets and gateway URLs in `_meta` only; include exact `ui.csp.connectDomains` and optional widget metadata.
- [ ] Build/typecheck and run MCP tools-list tests confirming exactly 15 tools remain.
- [ ] Commit `feat: register CPTR Live Workbench MCP resource`.

### Task 5: React widget and MCP Apps bridge

**Files:**
- Create: `plugin/web/src/workbench.tsx`
- Create: `plugin/web/src/workbench.css`
- Create: `plugin/web/tsconfig.json`
- Modify: `plugin/package.json`
- Modify: `plugin/tsconfig.json`
- Test: `plugin/tests/workbench.test.ts`

- [ ] Write failing reducer/bridge tests for snapshot hydration, sequence deduplication, reconnect state, terminal state, bounded ring buffers, and `tools/call` Stop/Steer payloads.
- [ ] Run focused widget tests and verify RED.
- [ ] Implement one React mount using MCP Apps `ui/*` messages first, authenticated SSE via `fetch`/`ReadableStream`, `Last-Event-ID`, heartbeat timeout, bounded buffers, and no remount per event.
- [ ] Implement Activity, Terminal, Tools, Changes, Evidence tabs; status strip; Stop/Steer; approval/blocking/cancellation/terminal states; accessible keyboard focus; theme/high-contrast handling; responsive inline layout; feature-detected display mode and intrinsic height.
- [ ] Build the single browser module through esbuild and inline/serve it from the registered resource.
- [ ] Run widget tests, plugin test suite, typecheck, build, audit, and static secret/path review.
- [ ] Commit `feat: add inline CPTR Live Workbench widget`.

### Task 6: Integrated local and rendered verification

**Files:**
- Modify: `plugin/README.md`
- Add tests only where an uncovered contract is found.

- [ ] Run CPTR focused stream/event tests and the full current CPTR suite.
- [ ] Run plugin `npm test`, `npm run typecheck`, `npm run build`, `npm audit --omit=dev`, and `git diff --check`.
- [ ] Run an authenticated disposable CPTR task stream and monitor stream smoke, proving snapshot, live event, replay, cancellation, completion, and no post-terminal events.
- [ ] Start the local plugin, perform MCP initialize/tools/list, call task/monitor creation, inspect resource metadata, and consume the gateway stream with a test ticket.
- [ ] Run rendered UI QA using the available Browser skill first: page identity, nonblank DOM, no overlay, console health, screenshot, interaction proof, desktop and mobile-sized viewport where practical.
- [ ] Request an independent integration review and an independent security/code-quality review; address all Critical/Important findings.
- [ ] Update README with local run, MCP Apps bridge, stream lifecycle, auth, and the explicit boundary that real ChatGPT Developer Mode acceptance is not claimed locally.
- [ ] Leave both feature branches clean and unpushed; report exact SHAs, test results, review findings, and remaining production/ChatGPT validation work.
