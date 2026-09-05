# CPTR Cross-Repo Release Gate and Recovery Runbook

This runbook is the release contract for the three components that make up paired Chrome control from ChatGPT:

- **Plugin / public MCP edge** — `chatgpt-computer-plugin`
- **CPTR backend** — `computer`
- **Chrome device endpoint** — `chatgpt-chrome-extension`

A change is not release-ready merely because one repository is green or because ChatGPT can currently connect. The release is accepted only when the local implementation gates, the shared browser protocol gate, the public OAuth/MCP edge gate, the deployed MCP contract gate, and release-SHA convergence all pass.

## Failure classes this gate prevents

The gate is specifically designed to stop these regressions before they become an incident:

1. **Protocol-era regression** — a verifier accidentally exercises legacy `initialize` while production is intended to support MCP `2026-07-28`.
2. **OAuth edge regression** — Cloudflare Access/WAF intercepts `/mcp`, metadata, registration, or token traffic, or returns an HTML/interstitial response instead of the origin OAuth JSON contract.
3. **Credential logging regression** — authorization codes, PKCE verifiers, bearer credentials, refresh tokens, cookies, or device credentials appear in production logs.
4. **Cross-repo browser drift** — plugin, backend, and extension disagree on protocol version, action names, or which actions require a lease epoch.
5. **Deployment drift** — the service is healthy but runs a release SHA different from the intended Git revision.
6. **Generated-release contamination** — extension packaging output appears as untracked source and is accidentally included in a future change.
7. **Host-cache confusion** — the server is correct but ChatGPT still has an older approved MCP action snapshot. Host refresh/review is treated as a separate final gate, not as a server deployment mechanism.

## Contract ownership

The browser-device wire contract is checked in at:

```text
contracts/browser-protocol-v1.json
```

in all three repositories. Each repository must prove its implementation matches its local copy, and the plugin repository compares the three copies byte-semantically in CI.

The manifest contains:

- `contract`
- `contract_revision`
- `protocol_version`
- `browser_actions`
- `mutating_browser_actions`

For a compatible addition, update implementation and manifest in all three repositories. For a breaking wire change, increment `protocol_version` and implement an explicit transition/compatibility window rather than silently replacing protocol v1.

Never change only one copy to make a failing gate green. The failure means the release unit is inconsistent.

## Local pre-merge gates

### Plugin

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run check:cross-repo-contract
```

`npm run check:release` runs the plugin typecheck, full tests, production build, and cross-repo browser-contract check in one command when sibling repositories are available.

### Backend

The existing backend CI runs the complete Python suite. The browser contract has an explicit self-consistency test:

```bash
python -m pytest -q tests/test_browser_protocol_contract.py
```

Any browser protocol change must also run the browser device/router safety suites before merge.

### Chrome extension

```bash
npm ci
npm run check
```

`npm run check` includes typecheck, ESLint, Vitest, and the production extension build. The protocol test verifies the extension implementation against `contracts/browser-protocol-v1.json`.

Generated `release-*` and `hotfix-*` directories are ignored and are not source artifacts.

## CI gates

The plugin repository has three independent workflows:

- **Plugin CI** — typecheck, test, production build.
- **Cross-repo contract** — checks out backend `main` and extension `main`, then requires exact browser-contract convergence. It also runs daily so drift caused by a later merge in another repository is detected even when the plugin repository did not change.
- **Production qualification** — runs a daily unauthenticated public-edge canary through Cloudflare and also supports a manual post-deploy gate that checks the authenticated MCP `2026-07-28` contract at an operator-supplied immutable release SHA.

The Chrome extension has its own CI workflow running `npm run check` on pull requests and `main`.

The backend's existing CI automatically includes `tests/test_browser_protocol_contract.py` because it runs the full Python suite.

If the related repositories are private, configure a repository secret named `CPTR_CROSS_REPO_TOKEN` with read-only contents access to the backend and extension repositories. The workflow falls back to the normal GitHub token where that token already has sufficient access.

Production qualification uses repository variables `CPTR_DEPLOYED_MCP_URL` and `CPTR_DEPLOYED_PUBLIC_ORIGIN`, plus the repository secret `CPTR_DEPLOYED_MCP_TOKEN`. The endpoint/origin are non-secret configuration; the bearer must remain a GitHub Actions secret and must never be committed or printed.

Branch protection should require the repository-local CI check. For the plugin repository, also require the cross-repo browser-contract check before merging protocol-affecting changes.

## Safe cross-repo change order

For an additive browser protocol change:

1. Add backward-compatible backend support and update the backend manifest/test.
2. Add extension support and update the extension manifest/test.
3. Update the plugin implementation and manifest.
4. Run the three repository-local gates.
5. Run the plugin cross-repo contract gate against the exact revisions intended for release.
6. Deploy the backend first while preserving compatibility with the currently released extension/plugin.
7. Release/update the extension.
8. Deploy the public MCP/plugin edge last.
9. Run the public-edge and deployed-contract gates.
10. Refresh/review the ChatGPT app action snapshot only when the MCP schema changed.

For a breaking browser protocol change, do not use this sequence without a dual-version transition. A new protocol version must coexist long enough to avoid stranding an older extension or plugin.

## Production OAuth / Cloudflare boundary

Cloudflare remains the TLS/WAF/reverse-proxy boundary. The origin is responsible for MCP resource-server authorization and the native OAuth server contract.

Cloudflare Access must be scoped to the interactive identity step only:

```text
/oauth/login
```

The following paths must reach the origin without an Access login interstitial:

```text
/mcp
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-protected-resource
/.well-known/oauth-authorization-server
/oauth/register
/oauth/authorize
/oauth/token
/oauth/revoke
/health
```

WAF policy must allow standards-valid JSON registration requests and `application/x-www-form-urlencoded` token requests to reach the origin. Do not permanently disable broad managed protection to solve a single false positive; use the narrowest route/rule exception necessary and keep the public-edge canary as the regression detector.

The OAuth token endpoint must never log raw request headers or form bodies. In particular, never log:

- `Authorization`
- authorization `code`
- `code_verifier`
- `refresh_token`
- cookies
- device credentials / pairing claim secrets

Operational diagnostics should log bounded request IDs, status classes, route names, duration, and redacted error categories instead.

## Public-edge qualification

Run this without an MCP bearer token:

```bash
CPTR_DEPLOYED_MCP_URL="$CPTR_DEPLOYED_MCP_URL" npm run check:public-edge
```

The check verifies through the actual public proxy/WAF path:

1. `/health` is production-ready.
2. RFC 9728 path-specific protected-resource metadata is reachable and advertises `/mcp`.
3. OAuth authorization-server metadata is same-origin and advertises CIMD, PKCE S256, and refresh-token support.
4. A native loopback dynamic-client registration reaches the origin and succeeds.
5. An intentionally invalid token exchange reaches the origin and returns the expected JSON OAuth error rather than a WAF/Access response.
6. An unauthenticated MCP `2026-07-28` `server/discover` request receives the origin's `401` challenge containing canonical `resource_metadata`.

A connector being able to open is not a substitute for this gate.

## Deployed MCP contract qualification

After deployment, run:

```bash
CPTR_DEPLOYED_MCP_URL="$CPTR_DEPLOYED_MCP_URL" \
CPTR_DEPLOYED_MCP_TOKEN="$CPTR_DEPLOYED_MCP_TOKEN" \
CPTR_EXPECTED_RELEASE_SHA="$CPTR_EXPECTED_RELEASE_SHA" \
npm run check:deployed-contract
```

The verifier uses the official MCP v2 client and pins negotiation to `2026-07-28`; it must not fall back to the legacy `initialize` era. It verifies:

- modern MCP era and exact negotiated protocol revision
- canonical application/contract version
- optional exact deployed release SHA
- Workbench readiness and build fingerprint
- no production `/__cptr/dev/*` routes
- exact 90-action registered MCP surface
- `client_model` self-reporting schema on every action
- single Live Workbench UI owner
- Apps resource URI, MIME type, CSP, and widget domain

The release is rejected if any of these drift.

## Host systemd release qualification

Production must have exactly one systemd drop-in with authority to select the immutable release. Historical drop-ins may remain only if they do not redefine `WorkingDirectory`, `ExecStart`, `NODE_ENV`, `CPTR_HOT_RELOAD`, `CPTR_WORKBENCH_BUILD_ID`, or `GIT_COMMIT_SHA`.

Run the host gate on AWS with operator-configured values rather than hardcoded paths:

```bash
CPTR_SYSTEMD_UNIT="$CPTR_SYSTEMD_UNIT" \
CPTR_RELEASE_ROOT="$CPTR_RELEASE_ROOT" \
CPTR_RELEASE_DROPIN_PATH="$CPTR_RELEASE_DROPIN_PATH" \
CPTR_SERVICE_ENV_FILE="$CPTR_SERVICE_ENV_FILE" \
CPTR_NODE_BIN="$CPTR_NODE_BIN" \
CPTR_EXPECTED_RELEASE_SHA="$CPTR_EXPECTED_RELEASE_SHA" \
sudo -E npm run check:host-release
```

The gate requires:

- a full 40-character target Git SHA
- effective `WorkingDirectory` equal to that immutable release directory
- effective `ExecStart` pointing to that release's compiled server
- the configured canonical release drop-in to be active
- no second drop-in with release-selection authority
- the durable service environment file does not define `GIT_COMMIT_SHA`, `CPTR_WORKBENCH_BUILD_ID`, `NODE_ENV`, or `CPTR_HOT_RELOAD`; those keys belong only to the release drop-in
- `NODE_ENV=production`
- `CPTR_HOT_RELOAD=0`
- build ID and `GIT_COMMIT_SHA` equal to the target SHA
- systemd `active/running`

This prevents both lexical drop-in ordering and `EnvironmentFile` precedence from silently selecting or advertising an old release. The gate needs read access to the protected service environment file, so run it with the host's existing non-interactive privilege boundary rather than weakening that file's permissions.

## Release-SHA convergence

The intended revision must be one immutable Git SHA. Set that SHA as `CPTR_EXPECTED_RELEASE_SHA` for post-deploy verification.

The following values must agree:

1. intended/approved Git SHA
2. immutable release directory identifier on the AWS host
3. systemd `ExecStart` release directory
4. `/health.release`
5. `cptr_plugin_update` release SHA

Do not accept “the service is up” as deployment proof when these disagree.

## AWS service requirements

The production service should:

- run as a dedicated non-root identity
- load secrets/configuration through an owner-readable environment file
- execute the compiled production server from an immutable release directory
- set `NODE_ENV=production`
- use bounded restart behavior
- preserve the durable native-OAuth state database outside the immutable release directory
- never use the development `tsx server/index.ts` entry point
- never enable Workbench hot reload in production

A release should be built and verified before the service pointer/`ExecStart` is changed. Preserve the prior immutable release for rollback until the new post-deploy gates pass.

## Live Terminal lifecycle invariant

The Workbench deliberately keeps its prompt SSE transport resumable across ChatGPT turn boundaries. Transport connectivity and active ChatGPT work are separate states and must never be collapsed into one badge:

- `WORKING`/target lifecycle states mean a CPTR tool, command, task, or browser lease is actively owned by the current interaction.
- `DISCONNECTED` means the ChatGPT turn has no active CPTR work target or tool lifecycle, even when the persistent prompt transport is still healthy.
- `SSE LIVE`, `SSE CONNECTING`, `SSE RECONNECTING`, and `SSE OFFLINE` describe only transport health in the footer.
- After the final unbound MCP tool completes, fails, is cancelled, or is blocked, the header must return to `DISCONNECTED`; it must not remain `CONNECTING` or become `LIVE` merely because the SSE connection is open.
- Do not close the persistent prompt SSE simply to obtain a `DISCONNECTED` header. That would break cross-turn resume and iOS suspension recovery.
- A bound task/monitor/command keeps its authoritative target lifecycle until it reaches a terminal state; browser control separately uses its lease/released lifecycle.

The UI regression gate in `tests/terminal-view.test.ts` explicitly verifies `DISCONNECTED + SSE LIVE` and `DISCONNECTED + SSE RECONNECTING` so future transport work cannot reintroduce the stuck-CONNECTING bug.

## Deployment acceptance sequence

The production plugin deployment is accepted only in this order:

1. Source tree clean and target SHA recorded.
2. Plugin local release gate green.
3. Cross-repo browser contract green.
4. Build immutable release from the recorded SHA.
5. Install production dependencies/build artifacts without mutating source.
6. Switch `cptr-mcp.service` to that immutable release and restart the service.
7. Run `npm run check:host-release` and require exactly one release-authority systemd drop-in.
8. Verify systemd reports active/running and the expected release directory.
9. Run `npm run check:public-edge` through Cloudflare.
10. Run `npm run check:deployed-contract` with `CPTR_EXPECTED_RELEASE_SHA`.
11. Verify `cptr_plugin_update` reports the expected contract/release.
12. If MCP action schemas changed, perform ChatGPT's native app Refresh/review and verify again.

Do not skip gates 7–11 because the health endpoint is green.

## Rollback

If a post-deploy gate fails:

1. Stop promotion of the failed release.
2. Point the service back to the last known-good immutable release.
3. Restart and verify service health.
4. Re-run the public-edge gate.
5. Re-run the deployed-contract gate using the rollback SHA.
6. Keep the failing release directory for forensic comparison until the incident is closed.
7. Fix the root cause on a normal branch/PR; do not patch an immutable deployed directory in place.

For an OAuth/Cloudflare incident, distinguish these layers before changing policy:

```text
client -> Cloudflare Access -> Cloudflare WAF -> public plugin origin -> OAuth/MCP handler -> CPTR backend
```

Record the first layer that changes the expected status/content type. A `403`/HTML response at the edge is a different failure from a structured origin `400` OAuth error.

## Incident evidence checklist

Capture these without secret values:

- UTC timestamp and public path
- HTTP status and content type
- Cloudflare rule/ray identifier where available
- intended Git SHA
- `/health.release`
- systemd release directory
- plugin contract/application version
- negotiated MCP era/revision
- local gate results
- cross-repo contract result
- public-edge result
- deployed-contract result
- exact rollback SHA if rollback occurred

Never paste bearer tokens, refresh tokens, PKCE verifiers, cookies, private keys, OAuth client secrets, or device credentials into incident notes.

## Definition of done

A cross-repo change is complete only when:

- all repository-local tests/builds are green
- all three browser manifests are identical and implementation-consistent
- extension working tree has no generated release pollution
- public OAuth/MCP edge qualification passes
- host systemd release qualification proves one release-authority drop-in
- deployed contract pins MCP `2026-07-28` and passes
- deployed SHA equals the intended SHA
- documentation describes any new invariant or migration rule
- host Refresh/review is completed when required by an MCP schema change

Anything less is an intermediate state, not a production-closed release.
