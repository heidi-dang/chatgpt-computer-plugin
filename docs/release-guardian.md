# Release Guardian v1

Release Guardian is a fail-closed read-only qualification gate. It does not merge, deploy, restart services, acquire credentials, or change production data.

## Release tuple and gates

The release candidate must provide exact 40-character lowercase Git SHAs for the plugin, CPTR backend, and Chrome extension. The runner rejects unexpected Git roots, revision mismatch, and (in CI) dirty checkout trees.

1. Verify browser protocol compatibility across pinned repositories.
2. Execute session recovery regressions: live/prompt sealed tickets, durable revocation, Workbench restart and replay, stateless binding, browser device transport, OAuth state and terminal parity.
3. Typecheck the plugin.
4. Execute the full plugin test suite.
5. Build the production plugin.

All five checks must pass. Failed, missing and skipped checks are not acceptable. The JSON evidence file records the exact tuple, plugin version, exit codes, durations and output SHA-256 fingerprints. It intentionally excludes raw logs and secrets.

## Release acceptance

The production-qualification workflow requires a successful Release Guardian job, public-edge canary, and the authenticated deployed MCP contract check for the configured Cloudflare auth mode. Managed OAuth acceptance must use the intended short-lived Managed OAuth token; do not substitute an origin bypass token.

Manual workflow_dispatch requires expected_release_sha, backend_release_sha, and extension_release_sha. Scheduled canaries check the public edge but are not release acceptance.

The plugin/backend/extension Git checkouts use the declared immutable revisions. Private sibling repositories may require the existing CPTR_CROSS_REPO_TOKEN repository secret. Guardian uploads a JSON artifact retained 30 days and records a job summary.

## Reproduce locally

From a pinned plugin worktree with Node.js 22 dependencies installed:

    node scripts/release-guardian.mjs --plugin=. --backend=/path/to/computer --extension=/path/to/extension --plugin-sha=FULL_PLUGIN_SHA --backend-sha=FULL_BACKEND_SHA --extension-sha=FULL_EXTENSION_SHA --output=/tmp/guardian-evidence.json --require-clean=true

Use --require-clean=false only for deliberate uncommitted local changes; such a run does not establish immutable release acceptance.

## Verification boundaries

Regression checks are deterministic local verification. They do not prove a real production restart, Chrome device reconnection, Cloudflare refresh, cross-node failover, performance SLOs, or successful rollback. GitHub artifact retention is not a server-side Capability OS signed evidence ledger. Those require independent environment-qualified evidence.
