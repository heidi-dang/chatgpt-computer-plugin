# Phase 2: Native ChatGPT five-way subagent host qualification

## Scope and actual host result (2026-10-08)

- Plugin release **1.4.8**, commit **93ec9e1492583419bfeeb29f5b9851f8d81602ff**, compact MCP with 16 tools.
- An actual ChatGPT Official `cptr_factory(action="spawn_multiple_subagents")` attempt used
  exactly five read-only audit objectives, `coding=false`, one unique idempotency key.
- Result: **`MissingRequiredClientCapabilityError`**. This ChatGPT MCP host did
  not advertise the `sampling.tools` capability. The plugin returned its explicit
  required-capability error *before any child task or worker allocation*.
- Before/after Direct Coding Worker count: **8 / 8**, unchanged, with original
  workers left intact. **Zero native ChatGPT continuations were created.**
- Do not replace native client sampling with Hermes, Codex, CPTR delegated agents,
  Dark Factory, autonomous monitors or a synthetic model.

## Evidence and safety contract

`server/native-subagents.ts` calls `assertSamplingToolsCapability` before
`NativeSubagentStateStore.begin`, `capabilityOs("spawn_multiple_subagents")`, or
Direct Coding Worker creation. Client identity/model name is only a hint; it is
**not** evidence of sampling support or authorization. Per-request capability
metadata is authoritative when explicitly present; only when absent can a
negotiated initialization capability be used.

The five-way regression tests enforce:

1. A host without `sampling.tools` rejects even a correct read-only five-way
   request, including an identical retry; it leaves no backend children, workers
   or persisted fan-out state.
2. With the capability legitimately advertised (unit simulation), all five
   `sampling/createMessage` requests are delivered together in the **single**
   MCP input-required response, and a retry reuses the cohort without spawning
   duplicates. This simulated test is **not** production fan-out proof.

## Required actual-host acceptance

1. ChatGPT MCP client initialization or per-request metadata must genuinely
   advertise `sampling: {tools:{}}`, enabling client-sampling and tool execution.
   This capability is controlled by ChatGPT, not by the plugin and not by a
   user-supplied `client_model` or tool arguments. Reconnecting or refreshing
   the plugin *may* update the snapshot, but cannot invent host capabilities.
2. Verify exact loaded plugin SHA and `2026-07-28` MCP contract; record existing
   worker count, use exactly five distinct read-only objectives with `coding=false`.
3. Verify all five sampling continuations are requested in the same MCP round,
   returned independently, correlated with separate child tasks, with no
   duplicated work on a repeated idempotency key.
4. Test cancellation, truncated results, failed sampling, retries, cleanup,
   failure isolation, limits, observability and preserved dirty workers.
5. Only after the read-only phase passes may a separately authorized five-way
   `coding=true` drill validate distinct Direct Coding Worker worktrees, unique
   branches and authority. Never merge/commit/deploy child output automatically.

**Current status:** Code and simulated regression contract verified. The actual
ChatGPT host capability gate prevents real five-way qualification; do not
weaken the capability requirement to make a test pass.
