# ChatGPT Official UI — Fixed Bugs, Performance Invariants, and Future Triage

This document is the regression index for the CPTR Live Workbench as rendered inside ChatGPT Official, with particular attention to the iOS app. Use it before making a new UI fix. The intent is to narrow future incidents by symptom, identify the owning layer quickly, and avoid reintroducing an already-fixed failure mode.

## Architectural boundary

The ChatGPT widget is a projection of CPTR state, not an execution engine.

Server-authoritative state includes execution lifecycle, task/monitor/command identity, replay cursors, live tickets, browser session identity, browser lease owner/epoch, authorization, recovery, persistence, retries, and artifact ownership. The widget may hold transient render state and may persist only bounded presentation preferences through ChatGPT widget state.

**Allowed persisted widget-local fields:**

- `surfaceMode`: `terminal | browser`
- `terminalFollow`: boolean

**Never persist in ChatGPT widget state:**

- bearer/live/prompt tickets or any credential
- workspace, task, monitor, command, worker, browser-session, or artifact IDs
- browser lease owner or epoch
- replay cursor / event sequence
- execution status or completion evidence
- command output or terminal transcript
- browser frame contents
- pixel `scrollTop`

The single UI-producing MCP tool remains `cptr_open_live_workbench`. Data/action tools must not create additional widget roots.

---

## Fast symptom-to-subsystem map

| Symptom in ChatGPT Official | Inspect first | Expected invariant / likely regression |
| --- | --- | --- |
| Tool call has no clean progress text or host narration is noisy | `server/mcp.ts`, `tests/mcp.test.ts` | Tool invocation metadata is bounded and host-native; do not create another widget to show progress. |
| Workbench says **DISCONNECTED** while the prompt stream is healthy or merely reconnecting | `web/src/workbench.tsx`, `web/src/terminal-view.tsx`, `tests/terminal-view.test.ts` | Prompt transport state and execution lifecycle are separate. Healthy idle prompt SSE renders LIVE; transport recovery renders RECONNECTING. |
| iPhone/iOS resume/remount gets `429` although an older Workbench is stale | `server/live-viewers.ts`, `server/prompt-terminal.ts`, `server/live-gateway.ts` | Newer viewer arbitration happens before capacity rejection; a new mount can replace the stale stream occupying the last slot. |
| Old chat card wakes and steals the stream from the new card | `server/live-viewers.ts`, `tests/live-ticket-recovery.test.ts` | Viewer with newer `startedAt` wins; an older viewer receives superseded/409 and cannot reclaim the scope. |
| Workbench uses stale ticket/prompt metadata after a tool result or renewal | `web/src/workbench.tsx` → `useMcpBridge`, `tests/terminal-view.test.ts` | Consume `ui/notifications/tool-result` and refresh `cptr/prompt` metadata without remounting the app. |
| Browser activity keeps forcing the UI back to Browser after user selects Terminal | `web/src/workbench.tsx` → `visibleBrowserSession` / `surfacePreference` | Auto-open Browser at most once for a new live browser session and only when the user has not chosen a surface. |
| Workbench forgets Terminal/Browser selection after ChatGPT remount | `web/src/workbench.tsx` → `widgetState`, `tests/terminal-view.test.ts` | Restore only bounded presentation state from `window.openai.widgetState`. |
| Scrolling terminal causes excessive React/host updates | `web/src/terminal-view.tsx` → `setFollow`, `web/src/workbench.tsx` → `setTerminalFollow` | Follow state is edge-triggered; unchanged scroll frames must not call `onFollowChange` / `setWidgetState`. |
| Light ChatGPT theme still shows dark native controls/scrollbars | `web/src/workbench.tsx` → `useHostTheme`, `web/src/workbench.css`, `server/ui/workbench-resource.ts` | Explicit ChatGPT theme wins; system `prefers-color-scheme` is fallback only; HTML advertises both `dark light`. |
| Widget height pulses, clips, or grows with document scroll height | `web/src/workbench.tsx` → `useWorkbenchAutoSize`, `web/src/workbench.css` | Measure `.terminal-workbench`, coalesce with RAF, ignore <2 px changes, never size from document/body scroll height. |
| Long terminal becomes slow/janky | `web/src/terminal-view.tsx`, `web/src/state.ts` | Render window is bounded, rows are memoized, follow scrolling is RAF-coalesced, frame uses CSS containment. |
| Terminal duplicates output after reconnect/resume | `web/src/state.ts`, `web/src/workbench.tsx`, `server/prompt-terminal.ts`, live gateway tests | Monotonic sequence/cursor and replay-after-cursor semantics are exactly-once at the projection layer. |
| Direct worker status appears but real command stdout disappears | `web/src/workbench.tsx`, `tests/terminal-view.test.ts`, stateless binding tests | `direct.worker` metadata never clears a previously bound `live.bind` command target. |
| Hidden Browser keeps using CPU/network or Chrome capture rate | `web/src/browser-surface.tsx`, browser input gateway | Intersection + document visibility drive source visibility; hidden state requests `max_fps: 0` and aborts frame polling. |
| Browser preview turns off immediately after iOS resume | `web/src/browser-surface.tsx` → `streamConfigQueue` | Visibility writes are serialized so stale cleanup `visible:false` cannot overtake a new `visible:true`. |
| CSP console warning tempts a wildcard/`unsafe-eval` fix | `server/ui/workbench-resource.ts`, HTTP/CSP config | First identify whether the source is CPTR or ChatGPT/extension code. Do not widen CPTR CSP/origins to silence host-side warnings. |

---

# Fixed bug catalog

## UI-001 — Missing/unclean ChatGPT-native tool progress

**Fixed in:** `bfba38a` (`fix(ui): surface ChatGPT tool progress cleanly`)

**Symptom:** ChatGPT Official tool activity did not surface a clean bounded progress state, encouraging UI-side progress duplication.

**Root cause:** MCP tool descriptors were not consistently providing the host-native invocation metadata needed for ChatGPT to render concise progress around tool calls.

**Fix:** Keep progress on the MCP descriptor/host layer rather than creating per-call widget UI. The Workbench remains the one persistent visual surface.

**Regression tests:**

- `tests/mcp.test.ts`
- `tests/workbench.test.ts`
- `tests/terminal-view.test.ts`

**Do not regress by:** adding a second render tool/card merely to show tool progress.

---

## UI-002 — Idle prompt transport incorrectly looked disconnected

**Fixed in:** `bfba38a`

**Symptom:** An open Workbench with no active bound command/task could render a disconnected-looking execution state during normal prompt-stream connection/recovery.

**Root cause:** Transport state and execution lifecycle were conflated.

**Fix:** Keep prompt SSE transport status separate from lifecycle status. An unbound healthy Workbench is READY/LIVE; reconnecting transport is RECONNECTING; DISCONNECTED is reserved for genuinely unavailable/expired prompt streaming.

**Regression test:** `tests/terminal-view.test.ts` — idle prompt lifecycle and iOS remount cases.

---

## UI-003 — Stale prompt metadata in reused ChatGPT iframe

**Fixed in:** `9ffe560` (`fix(ui): harden ChatGPT Workbench lifecycle`)

**Symptom:** A reused iframe could continue using old prompt/ticket metadata after ChatGPT delivered a newer tool result.

**Root cause:** The widget initialized from `window.openai.toolResponseMetadata` but did not consume the standard MCP Apps `ui/notifications/tool-result` update path.

**Fix:** `useMcpBridge` listens for `ui/notifications/tool-result`, searches the result/metadata envelope for `cptr/prompt`, and updates prompt metadata in place.

**Regression test:** `tests/terminal-view.test.ts` — `Workbench consumes standard MCP Apps tool-result notifications...`.

**Inspect when debugging:** If the UI is stale but the server issued a renewed ticket, inspect the host notification before touching ticket TTLs.

---

## UI-004 — Browser events repeatedly stole the selected tab

**Fixed in:** `9ffe560`

**Symptom:** User switches to Terminal, then later browser-surface activity forces Browser back into view.

**Root cause:** Every live `browser.surface` event with an owner could call `setSurfaceMode("browser")`.

**Fix:** Track the browser session already surfaced and auto-open only once per new session. Once the user explicitly chooses a surface, `surfacePreference` wins.

**Regression test:** `tests/terminal-view.test.ts` — browser auto-open once / selected-tab preservation.

---

## UI-005 — New iOS Workbench rejected with 429 at stream capacity

**Fixed in:** `9ffe560`

**Symptom:** ChatGPT iOS suspends/remounts the iframe; the stale stream still occupies the final concurrency slot; the new Workbench receives `429` and cannot become live.

**Root cause:** Capacity was checked before viewer arbitration. The server rejected the replacement before it had a chance to supersede/close the stale viewer.

**Fix:** Claim/arbitrate the viewer first. A `replaced` viewer is allowed a transient overlap while the old handler unwinds and releases its slot. Truly additional viewers still receive capacity rejection.

**Affected paths:**

- prompt stream: `server/prompt-terminal.ts`
- target stream: `server/live-gateway.ts`
- arbitration: `server/live-viewers.ts`

**Regression tests:**

- `tests/prompt-terminal.test.ts` — replacement at `maxConcurrent: 1`
- `tests/live-gateway.test.ts` — live target replacement at `maxConcurrent: 1`
- `tests/live-ticket-recovery.test.ts` — newest viewer wins and old card cannot reclaim

**Useful HTTP distinctions:**

- `409` + superseded state: this card is older than the active Workbench
- `429`: real capacity pressure, not a valid newer replacement
- `401`: ticket invalid/expired; try bounded renewal path

---

## UI-006 — Missing ChatGPT compatibility resource metadata

**Fixed in:** `9ffe560`

**Symptom:** Widget mounting/host presentation could vary across ChatGPT clients when only the MCP Apps-standard UI metadata was present.

**Root cause:** Compatibility aliases expected by ChatGPT were absent.

**Fix:** Mirror the bounded standard resource metadata into ChatGPT compatibility fields, including `openai/outputTemplate`, widget description/domain/border preference/CSP.

**Security invariant:** Compatibility metadata mirrors the existing exact domain lists. It must never widen CSP.

**Regression tests:** `tests/mcp.test.ts`, `tests/ui-resource.test.ts`.

---

## UI-007 — ChatGPT light theme could retain dark native color scheme

**Fixed in:** `b92899c` (`fix(ui): follow ChatGPT host color scheme`)

**Symptom:** ChatGPT is in light mode but widget-native controls/scrollbars or portions of the Workbench retain dark rendering.

**Root cause:** HTML declared only `color-scheme: dark`, while CSS light styling depended on device `prefers-color-scheme` rather than ChatGPT's explicit host theme.

**Fix:**

- consume `window.openai.theme`
- consume `openai:set_globals` theme changes
- set `data-theme` on the root
- use `:root[data-theme=light|dark]` for explicit host control
- use system preference only when no host theme exists
- advertise `dark light` in the HTML color-scheme meta

**Regression tests:** `tests/terminal-view.test.ts`, `tests/ui-resource.test.ts`.

---

## UI-008 — Workbench remount forgot user presentation preference

**Fixed in:** current hardening continuation after `b92899c`.

**Symptom:** ChatGPT remounts the iframe and a user who intentionally selected Terminal/Browser or disabled follow-latest returns to defaults.

**Root cause:** Presentation state existed only in React component memory.

**Fix:** Read `window.openai.widgetState` once at mount and persist only meaningful UI preferences with `window.openai.setWidgetState`.

**Persisted:** `surfaceMode`, `terminalFollow`.

**Explicitly not persisted:** any CPTR authority/execution/recovery state, any identity, any ticket, any transcript/frame data, and `scrollTop`.

**Regression test:** `tests/terminal-view.test.ts` — `Workbench persists only ephemeral presentation preferences...`.

**Diagnostic rule:** If a remount loses execution progress, do **not** add that progress to widget state. Fix SSE replay/ticket/workbench-session recovery instead.

---

## UI-009 — Scroll frames amplified into ChatGPT widget-state writes

**Fixed in:** current hardening continuation after `b92899c`.

**Symptom:** With presentation persistence enabled, terminal scrolling can repeatedly call the parent `onFollowChange` even though follow remains `true` or remains `false`, causing avoidable parent rerenders and host `setWidgetState` traffic.

**Root cause:** `TerminalView.setFollow()` published the callback on every RAF-coalesced scroll sample, not only on the boolean transition.

**Fix:** Track the current follow value in a ref and publish only when the value changes. Scrolling still records local pixel `scrollTop`, but host persistence is edge-triggered. The widget-state writer also skips an identical `surfaceMode`/`terminalFollow` snapshot, so clicking an already-selected surface does not produce a redundant host write.

**Regression test:** `tests/terminal-view.test.ts` — `terminal follow changes are edge-triggered...` and `Workbench persists only ephemeral presentation preferences...`.

**Performance implication:** host-state writes now happen only on meaningful presentation-state transitions, not at scroll-frame frequency or repeated selection of the current surface.

---

# Existing performance invariants that future fixes must preserve

These are already in the implementation and are part of the regression surface even when a later bug is unrelated.

## Terminal render budget

- Maximum rendered rows: **600 desktop**, **320 mobile** (`web/src/terminal-view.tsx`).
- Older transcript data can remain in state/evidence, but DOM rendering is windowed to the newest rows.
- `TerminalLine` is `React.memo`-wrapped.
- follow scrolling is `requestAnimationFrame`-coalesced.
- terminal layout uses CSS containment (`contain: layout paint style`).
- terminal output uses bounded overscroll behavior.
- mobile typography/height is explicitly tuned at `560px` and `390px` breakpoints.

Historical anchor: `173a69b` (`perf: optimize live terminal for iPhone`).

## Host sizing budget

- Observe `.terminal-workbench`, not document/body scroll height.
- Coalesce `ResizeObserver` changes through one RAF.
- Ignore height changes smaller than 2 px.
- Publish through both ChatGPT host intrinsic-height API and MCP Apps `ui/notifications/size-changed` compatibility path.

Historical anchor: `b91c0c0` (`fix: bound live terminal host sizing`).

## Prompt/live SSE recovery budget

- reconnect backoff caps at **15 seconds**.
- resume uses monotonic `Last-Event-ID` / sequence cursor.
- replay rejects duplicate/old sequence numbers.
- `pageshow`, `online`, and `visibilitychange` wake suspended iOS views.
- stale viewer arbitration prevents old persistent cards from reclaiming newer streams.
- prompt and target tickets use bounded expiry/renewal semantics; tickets are never placed in URLs.

Historical anchor: `6212551` (`fix: make Live Workbench restart-safe`).

## Browser preview budget

When visible:

- `max_fps: 10`
- `max_width: 1280`
- quality `68`

When hidden:

- `max_fps: 0`
- polling is aborted
- source visibility is explicitly disabled

Visibility requests are serialized through `streamConfigQueue` to prevent an old effect cleanup from disabling a newly resumed preview.

Historical anchor: `5dda811` (`feat: suspend hidden browser source streaming`).

## Bundle budget

The build enforces a **450,000-byte** production Workbench bundle ceiling through `scripts/check-workbench-bundle.mjs`.

The 2026-09-08 hardening branch builds the production Workbench at **180,398 bytes**, leaving substantial headroom while retaining the recovery and persistence logic in this document.

Do not trade a UI symptom for a large framework/runtime dependency without demonstrating a net improvement under the existing bundle gate.

---

# Historical recovery anchors

Use these commits when a future regression resembles an older failure:

| Commit | Area |
| --- | --- |
| `6212551` | Restart-safe sealed live/prompt tickets, stale-viewer handling, iOS wake/recovery |
| `0de6f70` | Keep persistent prompt terminal connected between ChatGPT turns |
| `06c28cd` | Browser human-control return path |
| `5dda811` | Suspend hidden browser source streaming |
| `173a69b` | iPhone terminal render/layout optimization |
| `b91c0c0` | Bounded intrinsic host sizing |
| `bfba38a` | Host-native tool progress and lifecycle cleanup |
| `9ffe560` | Tool-result refresh, browser-tab preservation, stream replacement at capacity, compatibility metadata |
| `b92899c` | ChatGPT host theme / color-scheme alignment |

Always inspect the actual diff/tests for the referenced commit before copying an old fix pattern.

---

# Future incident triage procedure

## 1. Classify the symptom before editing

Choose one primary category:

1. **Host integration** — tool progress, resource metadata, widget mount, theme, host globals.
2. **Prompt transport** — activity feed, ticket renewal, prompt SSE, between-turn persistence.
3. **Bound live target** — task/monitor/command snapshot, replay, stdout/stderr stream.
4. **Browser surface** — paired Chrome session, lease/epoch, frame visibility, human input.
5. **Rendering/performance** — DOM size, scroll/follow, resize, bundle, mobile layout.

Do not fix a transport problem with CSS or widget persistence. Do not fix a rendering problem by changing server authority.

## 2. Capture evidence without secrets

Record:

- visible symptom and exact status label
- desktop/iOS and viewport width/orientation
- whether document is visible/hidden and whether this followed suspend/resume
- prompt stream HTTP status (`200/401/409/429/...`)
- live-target stream HTTP status
- current event sequence / `Last-Event-ID` number only
- target type (`task/monitor/command`) without logging bearer tickets
- browser mode/owner/epoch when the symptom is browser-specific
- ChatGPT theme (`light/dark`)
- whether the affected card is the newest Workbench mount

Never record bearer tokens, Cloudflare Access/JWT material, SSH credentials, browser credentials, or prompt/live ticket values.

## 3. Run the smallest matching regression suite

```bash
# General Workbench rendering, iOS behavior, theme, host state
npx tsx --test tests/terminal-view.test.ts

# Widget resource metadata / CSP aliases
npx tsx --test tests/ui-resource.test.ts tests/mcp.test.ts

# Prompt activity SSE / renewal / replay / replacement
npx tsx --test tests/prompt-terminal.test.ts tests/prompt-ticket-recovery.test.ts

# Bound task/command stream / stale viewer arbitration
npx tsx --test tests/live-gateway.test.ts tests/live-ticket-recovery.test.ts

# Stateless binding between prompt, worker metadata, and command targets
npx tsx --test tests/stateless-live-binding.test.ts
```

After a focused fix, run the full repository gates:

```bash
git diff --check
npm run build
npm test
npm run typecheck
npm run check:cross-repo-contract
```

If an MCP tool/action is added, removed, renamed, or its schema changes, also run:

```bash
npm run check:deployed-contract
```

A UI-only fix that does not change the MCP surface should not require widening the tool contract.

## 4. Interpret common stream statuses

- **200 + no activity:** inspect SSE frame parsing, visibility, cursor, and whether the target is actually bound.
- **401:** validate ticket expiry/renewal path; do not lengthen TTL before proving renewal failed.
- **409:** expected stale-viewer protection when a newer Workbench exists; investigate only if the newest card receives it.
- **429:** inspect true capacity vs. replacement arbitration. A legitimate newer replacement should not be rejected solely because its stale predecessor owns the last slot.
- **403/404/410 on bound stream:** treat as terminal/unavailable according to the current recovery contract, not as an infinite reconnect loop.

## 5. Check performance invariants before accepting the fix

A fix is incomplete if it causes any of the following:

- unbounded terminal DOM growth
- scroll-frame-frequency parent or host state writes
- hidden browser capture continuing at visible FPS
- ResizeObserver feedback loops
- duplicate widget roots/cards
- replayed terminal duplicates
- repeated Browser auto-focus after user choice
- widget state containing server-authoritative/security state
- CSP/origin wildcard or `unsafe-eval` widening
- bundle above the repository ceiling

---

# Future fixed-bug entry template

Append new bugs using this exact structure so searches remain consistent.

```markdown
## UI-NNN — Short symptom name

**First observed:** date / client / release

**Symptom:** What the user sees. Include the exact visible state or HTTP status when available.

**Reproduction:** Smallest deterministic sequence that triggers it.

**Root cause:** The first incorrect state transition, ordering rule, ownership rule, or render behavior — not the downstream symptom.

**Owning layer:** host integration | prompt transport | live target | browser surface | rendering/performance

**Fix:** Minimal root-cause change and why it is correct.

**Invariant added:** One sentence that future code must preserve.

**Regression test:** Exact test file and test name.

**Verification:** Focused command plus full repository gates that passed.

**Security/authority impact:** Explicitly state whether CSP, origins, permissions, leases, credentials, tool surface, or server authority changed. Expected default: none.

**Commit/PR:** Commit SHA and PR number.

**If it returns:** First files/log/status codes to inspect.
```

---

# Verification baseline for the 2026-09-08 hardening

The final code state documented here was checked with:

- `git diff --check`
- `npm run build` — Workbench bundle **180,398 / 450,000 bytes**
- `npm test` — **259/259 passed, 0 failed**
- `npm run typecheck`
- `npm run check:cross-repo-contract` — protocol v1, **52 actions**, **35 mutating actions** across plugin/backend/extension

No MCP tool/action was added, removed, renamed, or schema-changed by the continuation work. No CSP/origin wildcard, `unsafe-eval`, `git:write`, `deploy:write`, `allow_network: true`, or `allow_package_install: true` widening was introduced.

---

# Acceptance rule

A ChatGPT Official UI fix is not complete because it "looks better." It is complete when the root cause is identified, the correct ownership layer is changed, a regression test captures the failure mode, mobile/iOS semantics remain valid, performance/security invariants are preserved, and the repository verification gates pass.
