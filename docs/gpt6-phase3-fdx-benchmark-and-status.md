# Phase 3 — FDX and runtime optimisation baseline (2026-10-08)

**Status:** Started; not complete. This is an evidence and measurement patch, **not a claimed speed-up**. All work was performed in isolated worktrees or local FDX runtime caches; no MCP, backend, production service or Cloudflare OAuth configuration was modified.

## Scope and acceptance

Repair semantic indexing; measure repository retrieval, MCP tool-call overhead, command latency, SSE throughput, worker startup, and memory consumption before changing runtime bottlenecks. Exit requires fresh populated indexes, representative before/after comparisons, and no correctness or security regression.

## Local FDX facts

- FDX native 0.1.0; EvidenceGraph schema 10, tree-sitter compiled and locally available.
- Initial `index_status` observations: plugin **108 files / zero graph nodes**, backend **738 files / zero nodes**, extension **64 files / zero nodes**. These are local working checkouts, not all at identical main revisions.
- Running `fdx build refresh` populated built-in package/tsconfig dependency graphs: plugin **144 nodes / 145 edges**, backend **837 / 839**, extension **82 / 83**. This verifies *build/config* graph evidence, not semantic-source graph correctness.
- SCIP provider initially absent; local, non-global `@sourcegraph/scip-typescript@0.4.0` used to experiment in **.phase3-fdx-runtime only**. It emitted 76 documents, 50,015 occurrences, 14,135 nodes and 23,797 edges, but subsequent FDX `index --refresh` reported `semantic_rebuild_required`; status became degraded with zero retained semantic nodes. Repeating refresh did **not** fix the degradation. Thus **semantic indexing remains unqualified**, and this temporary provider must not be assumed installed on production or accessible to the CPTR service.
- Rust semantic provider reports unsupported. No new permission, scope, external indexing/telemetry service or global dependency was enabled.

## Reproducible measured baseline

Run using the installed FDX binary and an exact checkout:

```sh
FDX_BIN=/path/to/fdx node scripts/benchmark-fdx.mjs /path/to/repo SYMBOL_QUERY 5
```

This script launches bounded FDX CLI calls without a shell and discards the first run as a warm-up. Measurements below are **local GCloud CLI/process latency**, not ChatGPT end-to-end tool-call latency. Five measured iterations per probe, October 8, 2026; workloads are not equivalent across repositories:

| Repo checkout | Query | index status p50 / p95 | symbol search p50 / p95 |
| --- | --- | --- | --- |
| Plugin (older working checkout) | `workbench` | 17.55 / 19.62 ms | 134.70 / 178.53 ms |
| Backend (older working checkout) | `workspace` | 20.25 / 21.27 ms | 690.48 / 784.90 ms |
| Chrome extension (older working checkout) | `browser` | 16.62 / 23.97 ms | 49.48 / 77.00 ms |

Record exact repo SHA, machine workload, caching, failures, and both p50/p95 for any *future* before/after comparison; these small samples are a directional baseline only.

## Outstanding gates

1. Diagnose the SCIP-to-FDX index retention/freshness defect using the isolated local worktree before proposing an indexing-service change.
2. Qualify the provider as a pinned offline/reproducible toolchain and repeat index/query tests on the latest clean repo SHAs.
3. Profile **end-to-end** ChatGPT MCP overhead, command startup, SSE bursts, worker initialization, and backend memory/FDs using representative tests.
4. Optimize only proven bottlenecks, compare before/after on identical workload/revision, then run affected regression suites and security boundaries.

## Phase status and explicit Phase 4 acceptance

| Phase | State | Evidence |
| --- | --- | --- |
| 1 GPT-6 | Deployed | Plugin 1.4.8 at `93ec9e1492583419bfeeb29f5b9851f8d81602ff` |
| 2 native multi-agent | Blocked | ChatGPT MCP host does not advertise `sampling.tools`; no fallback or fabricated continuations |
| 3 FDX/runtime | In progress | This measurement baseline and unresolved semantic provider |
| 4 security/reliability incl. OAuth | **Closed by user acceptance, not globally requalified** | Current Cloudflare Managed OAuth works and user expressly forbids any changes to it |
| 5 ChatGPT-native UX | In progress | Isolated UI regression and test workstream |
| 6 deps/legacy | In progress | Isolated Chrome extension compatibility workstream |
| 7 release qualification | Pending | Final cross-repo and device/edge gates |

**Phase 4 constraint:** Never modify the current Cloudflare OAuth routing, Access rules, tokens, policies, WAF, Caddy OAuth endpoints or provider registrations as part of Phases 3/5/6. Phase 4 user acceptance waives further changes; it does not retroactively prove every unrelated security/reliability acceptance test passed.
