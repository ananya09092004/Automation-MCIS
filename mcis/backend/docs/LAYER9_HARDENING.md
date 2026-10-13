# Layer 9 — final gap closure / production hardening

Layer 9 adds no product layer. It closes the limitations documented in
Layers 1–8 (ledger: `LAYER9_LIMITATION_LEDGER.md` / `.json`), hardens
operations, and verifies the whole platform. Voice files are untouched
(checksums verified).

## 1. What changed

| Area | Change | Files |
|---|---|---|
| Auth (P15-1) | `ALLOW_UNAUTHENTICATED_API` ignored under `NODE_ENV=production` | `middleware/auth.js` |
| Auth (L2-4) | notification PATCH/DELETE carry a notification id, not a user id | `middleware/auth.js` |
| Team (L1-3, L1-6) | owner transfer (one DB transaction); invite-acceptance rate limit; audit hook | `services/workspaceService.js`, `services/workspaceStore.js`, `routes/workspaces.js` |
| Firewall (PRE-1, L6-4) | workspace emergency stop; IANA time zones in time windows | `services/security/policyEngine.js`, `securityService.js`, `routes/security.js` |
| Planner (L3-5) | goal and history always sanitized before the planner | `services/agentExecution/executionService.js` |
| Outputs (L4-3) | `table` and `artifact` structured-output types | `services/workflows/definition.js` |
| Limits (L7-2, L7-5) | members / active workflows verified under a per-workspace lock (no over-grant, no livelock); `max_concurrent_executions` enforced | `entitlementService.js` (`enforceCount`), `workflowService.js`, `workspaceService.js`, stores, migration |
| Connectors (L5-3, L5-2) | HTTP query-parameter auth; read-only Google Drive connector + workspace OAuth | `connectors/httpApiConnector.js`, `connectors/googleDriveConnector.js`, `connectorRegistry.js`, `security/googleDriveOAuth.js`, `routes/oauthCallbacks.js` |
| Credentials (L5-6, L6-6) | key-rotation job; OAuth refresh (single flight + cross-instance re-read) | `credentialService.js`, `integrationService.js`, `githubConnector.js`, `githubOAuth.js`, `scripts/rotate-integration-keys.js` |
| API (P12-1) | `GET /runs`, `GET /executions` with cursors and filters; documented | `routes/automation.js`, `services/automation/{pagination,apiSpec}.js`, stores |
| Operations (P13-1, L7-4) | request ids, metrics, worker heartbeats, readiness, retention | `services/ops/*`, `routes/ops.js`, `workflowRunner.js`, `server.js` |
| Data controls (L2-2) | exports redact secret columns; export/erase audited | `services/dataControlsService.js`, `routes/dataControls.js` |
| Config (P18-1) | new dangerous-config checks | `services/config/productionConfig.js` |
| Tooling | secret scanner, schema audit, load test | `scripts/secret-scan.js`, `scripts/schema-audit.sql`, `__tests__/load/loadTest.js` |
| Database (P1-1) | `pgcrypto` optional in every migration | `migrations/2026092{3..9}_*.up.sql` |
| Frontend | emergency stop, Drive connect, transfer ownership, data retention, verification email, workspace header on chat/memory/goals, token only to our API | `security/*`, `workspace/WorkspacePage.jsx`, `customer/customerApi.js`, `Auth.js`, `authFetch.js`, `components/SandboxExecutor.jsx` |

## 2. Migration `20261001_layer9_hardening`

- `transfer_workspace_ownership(ws, from, to)` — locks the workspace, demotes, promotes, updates `owner_id`.
- `enforce_active_workflow_limit(...)`, `enforce_member_limit(...)` — re-count under the workspace row lock; an over-limit caller's own write is undone in the same transaction.
- `workspace_retention_policies`, `retention_purge_workspace(...)` (floors 35 / 7 / 90 days enforced in SQL), `usage_events_immutable()` allows deletes only inside the purge (transaction-local flag).
- `worker_heartbeats`.
- RLS on; no client policies; `anon`/`authenticated` denied; functions service-role only.
- Down restores the Layer 7 trigger function byte-identically; no Layer 1–8 row changes.

## 3. Race-free count limits

Reservations cover metered limits (Layer 7). Count limits (members, active
workflows) are checked before the write and verified after it: under a
`SELECT … FOR UPDATE` on the workspace row the store counts again; if the
workspace is over its plan, the caller's own write (the invitation / the
activation) is undone before the lock is released. Verifiers are serialized,
so the count never stays above the limit and exactly `limit − existing`
concurrent writers succeed (tested with 6 concurrent invitations and 5
concurrent publishes, memory and PostgreSQL).

## 4. Multi-instance and uncertain writes

Executions are owned through leases (Layer 6), jobs through fenced leases
(Layer 4/6). Layer 9's deterministic two-worker test: worker A claims a run,
sends a non-idempotent click and "dies"; B cannot claim while A's lease is
valid, claims with a higher fence afterwards, and the run goes to
`needs_review` — the click is never re-sent.

## 5. Google Drive (read-only)

`list_files` (allowed folders only), `get_file`, `read_text` (Docs/Sheets/Slides
exported as text/CSV; text files; ≤100 KB) — GET requests to
`www.googleapis.com` through the SSRF-safe client, never redirects. Files
whose parent is not on the allowlist are refused after a metadata read. Off
unless `GOOGLE_DRIVE_ENABLED=true`. Workspace owners connect via OAuth
(`drive.readonly`, offline access); the public callback only forwards
code/state to the app in the URL fragment; completion is an authenticated
request bound to the owner and workspace (single-use state). Verified against
a local double of the Drive API and Google's token endpoint — not against
Google.

## 6. Measurements (local sandbox, `__tests__/load/loadTest.js`)

Doubles for Firebase, Gemini and the desktop bridge (5 ms per action). Not a
production capacity claim.

| Scenario | memory stores | local PostgreSQL 16 + PostgREST |
|---|---|---|
| 100 API run starts, 20 workspaces: start latency p50 / p95 | 208 / 319 ms | 2087 / 3777 ms |
| … all 100 runs completed | 0.64 s | 30.9 s |
| 400 concurrent `GET /runs` p50 / p95, throughput | 375 / 681 ms, 509 req/s | 2791 / 4738 ms, 84 req/s |
| 100 concurrent run starts against a 30-run plan | 30 accepted, 70 × 402 | 30 accepted, 70 × 402 |
| firewall `decide()` | 4.3 µs | 4.6 µs |

Correctness under load: every run completed, each desktop action executed
exactly once, no cross-workspace rows. The PostgreSQL numbers are dominated by
per-step database round trips through a single local PostgREST instance.

## 7. Verification

- Backend (memory): 345 tests in 11 suites; Layer 9 suite 28 (memory) / 29 (PostgreSQL).
- PostgreSQL: every Layer 1–9 suite; migrations up ×2 / down ×2 / up with Layer 1–8 data hashes unchanged; fresh L1–L9 up/down with the `pgcrypto` extension removed; schema audit 0 violations (negative control detected 3 injected violations).
- Frontend: 55 tests, production build.
- Mutation testing: 32 mutations of Layer 9 security checks, 32 killed (two needed stronger tests, added).
- Secret scan: repository clean; runtime scan in the suite.
