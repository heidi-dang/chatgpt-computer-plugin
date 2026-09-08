# ChatGPT Official UI Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the ChatGPT Official Live Workbench hardening, remove avoidable remount/scroll/render regressions, and leave a durable fixed-bug diagnostic index for future UI incidents.

**Architecture:** Keep the plugin as a thin ChatGPT-facing adapter. CPTR remains authoritative for execution, tickets, replay cursors, browser ownership, leases, and recovery; the widget may persist only ephemeral presentation preferences through ChatGPT widget state. UI performance work stays inside the existing single persistent Workbench, prompt SSE, live-target SSE, and paired-browser projection paths.

**Tech Stack:** TypeScript, React, Node.js MCP server, MCP Apps bridge, ChatGPT `window.openai` compatibility APIs, SSE, node:test/tsx.

**Spec:** `docs/superpowers/specs/2026-08-25-cptr-live-workbench-design.md`

## Global Constraints

- Preserve the compact MCP surface and the single UI-producing `cptr_open_live_workbench` tool.
- Do not move execution, persistence, authorization, recovery, browser ownership, leases, or artifact state into the widget.
- Do not widen CSP, origins, network permission, package installation, delegation, `git:write`, or `deploy:write`.
- Persist only bounded presentation state; never persist bearer tickets, target/workspace IDs, browser session/epoch/owner state, execution state, or credentials in ChatGPT widget state.
- Keep package.json as the version source of truth.
- If the MCP tool/action/schema surface changes, `npm run check:deployed-contract` is mandatory. This hardening must avoid such a surface change.
- Mobile/iOS behavior is a first-class acceptance target.

---

### Task 1: Finish remount-safe presentation state

**Files:**
- Modify: `web/src/workbench.tsx`
- Test: `tests/terminal-view.test.ts`

**Interfaces:**
- Consumes: `window.openai.widgetState`, `window.openai.setWidgetState(state)`.
- Produces: restoration of `surfaceMode` and `terminalFollow` only.

- [x] **Step 1: Add a regression test that rejects execution/security fields from persisted widget state.**
- [x] **Step 2: Verify the test covers restored Terminal/Browser selection and follow-latest state.**
- [x] **Step 3: Implement the minimal bounded widget-state reader/writer.**
- [x] **Step 4: Verify the focused Workbench UI tests pass.**

### Task 2: Prevent scroll-driven host-state write amplification

**Files:**
- Modify: `web/src/terminal-view.tsx`
- Test: `tests/terminal-view.test.ts`

**Interfaces:**
- Consumes: controlled `follow` state and `onFollowChange` callback.
- Produces: edge-triggered follow changes, so ordinary scroll frames do not repeatedly rerender the parent or call ChatGPT widget-state persistence.

- [x] **Step 1: Add a failing regression test requiring follow-state edge detection.**
- [x] **Step 2: Run `npx tsx --test tests/terminal-view.test.ts` and observe the intended failure.**
- [x] **Step 3: Add a ref-backed equality guard before publishing follow changes.**
- [x] **Step 4: Re-run the focused test and require it to pass.**

### Task 3: Publish the fixed-bug and performance diagnostic index

**Files:**
- Create: `docs/chatgpt-official-ui-fixed-bugs.md`

**Interfaces:**
- Consumes: current implementation, regression tests, current branch commit history.
- Produces: symptom-to-subsystem triage map, fixed bug catalog, performance budgets, security boundaries, diagnostic commands, and a template for recording future fixes.

- [x] **Step 1: Document every fixed ChatGPT-host UI regression in the current hardening branch.**
- [x] **Step 2: Document performance invariants and existing browser/terminal optimizations that future changes must preserve.**
- [x] **Step 3: Add a future-triage decision tree with exact tests and source files.**
- [x] **Step 4: Add a future bug-entry template that requires symptom, root cause, evidence, fix, tests, and regression risk.**

### Task 4: Full verification and review

**Files:**
- Review all changed files.

**Interfaces:**
- Produces: evidence that the branch is safe to review and merge.

- [x] **Step 1: Run `git diff --check`.**
- [x] **Step 2: Run `npm run build`.**
- [x] **Step 3: Run `npm test`.**
- [x] **Step 4: Run `npm run typecheck`.**
- [x] **Step 5: Run `npm run check:cross-repo-contract`.**
- [x] **Step 6: Review the diff for CSP/origin/authority/tool-surface widening and for widget-state leakage.**
- [x] **Step 7: Confirm the Workbench bundle remains below the repository limit.**

### Task 5: Commit, push, and PR closure

**Files:**
- Commit all verified plugin UI hardening and documentation.

**Interfaces:**
- Produces: a pushed branch and one canonical PR for the ChatGPT Official UI hardening.

- [ ] **Step 1: Commit only after all required gates pass.**
- [ ] **Step 2: Push `fix/chatgpt-ui-progress-20260908`.**
- [ ] **Step 3: Reuse/update PR #34 if it is still open; do not create a duplicate PR for the same branch.**
- [ ] **Step 4: Verify the PR head SHA and report the exact verification evidence.**
