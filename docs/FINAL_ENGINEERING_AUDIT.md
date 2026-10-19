# Final engineering audit — Automation-MCIS / Nexus

Branch `launch-readiness`, based on `f2be39b` (= `origin/main` at the start of this pass).
Every classification below is backed by a test run, a live request, or a code reading
noted next to it. Nothing is marked COMPLETE only because files exist.

Legend: **COMPLETE** (implemented and verified) · **INCOMPLETE** (partly implemented / not
verifiable here) · **BLOCKING** (must be fixed before the stated launch type) · **WARNING**
(acceptable for a pilot, should be fixed) · **NOT CONFIGURED** (code exists; needs an
external account or setting).

## 1. Repository and Git

| Item | Status | Evidence |
|---|---|---|
| Git state | COMPLETE | Clean tree at `f2be39b`; work done on the new branch `launch-readiness` in 3 local commits; no history rewritten; nothing pushed. |
| Committed secrets | COMPLETE | `node mcis/backend/scripts/secret-scan.js` → clean (628 files). Only `.env.example` files (names only) are tracked. |
| Local artifacts in Git | WARNING | `nexus-layer1-checkpoint.bundle` (3 MB git bundle of an earlier local checkpoint; secret scan of its content: clean), `nexus/screen.png` and `nexus/desktop_test.png` (real desktop screenshots showing a location and a Windows user path). Left untouched (removing them would delete files from the owner's working tree on pull); see LIMITATIONS.md. |
| Vendored binary | WARNING | `mcis-agent/mcis-agent-final/bin/sox/sox.exe` is intentionally bundled (`BUNDLE_SOX.md`). |
| CI / Docker / deploy manifests | NOT CONFIGURED | No `.github/`, no Dockerfile, no compose/k8s files. `nexus-web/vercel.json` is the only hosting file. |

## 2. Architecture

| Component | Path | Role |
|---|---|---|
| Backend API | `mcis/backend` | Express 5; Firebase Admin verifies ID tokens; Supabase (PostgREST) with the service-role key, server-side only. Hosts the voice/command routes, agent socket, and the Nexus SaaS layers 1–10. |
| MCIS app | `mcis/frontend` | Original React (CRA) application. **Unchanged** in this pass (`git diff f2be39b -- mcis/frontend` is empty). |
| Nexus web console | `nexus-web` (new) | Separate B2B SaaS console (Vite + React 19 + Firebase Auth) on the same backend. |
| Desktop agent | `mcis-agent/mcis-agent-final` | "Hey MCIS" wake word (Vosk), pairing, WebSocket to `/agent`. **Unchanged.** |
| Nexus engine | `nexus/` | Python (Windows-targeted): browser/desktop automation, planner, recovery, execution gateway, evidence, safe rollback, voice. **Unchanged.** |
| Database | `mcis/backend/migrations` | 11 idempotent up/down pairs (Layer 1–10 + `20261003_legacy_tables_rls`). |

## 3. Backend (`mcis/backend`)

| Area | Status | Evidence |
|---|---|---|
| Unit / integration tests | COMPLETE | `npm test`: 14 suites, 406 passed, 0 failed. Mutation test 43/43 killed. |
| PostgreSQL mode | COMPLETE | Against a real PostgreSQL + PostgREST: workspaces 44, data scoping 28, agent execution 37, workflows 49, integrations 34, security 35, billing 22, customer 26, hardening 29, revenue 50 — all pass. |
| Start-up, `/health`, `/health/ready` | COMPLETE | Live: 200 / 200 in development and in production mode. |
| Authentication | COMPLETE | No token → 401; forged token → 401; `ALLOW_UNAUTHENTICATED_API` is refused when `NODE_ENV=production` (log line verified). |
| Authorization / roles | COMPLETE | Owner/admin/member enforced server-side; live E2E: member gets 403 on admin actions. |
| Workspace isolation | COMPLETE | `resolveContext()` → non-members get 404 (live E2E cross-workspace check + PG suites). |
| Error responses | COMPLETE (fixed) | Before: CORS-denied origin and malformed JSON returned **500**. Now 403 / 400 / 413 / 415 with no internal details (`middleware/errorResponses.js`, 6 tests). |
| CORS | COMPLETE | Allow-list from `ALLOWED_ORIGINS`; denied origin gets 403 without `Access-Control-Allow-Origin`. `console.log('DEBUG allowedOrigins')` remains in `server.js` (WARNING, prints origins only). |
| Rate limiting | WARNING | Targeted DB-backed limits exist (invites, auth-sensitive routes); no global API limit; public pairing endpoints unlimited. `trust proxy` is not set, so per-IP limits would be wrong behind a proxy until the hosting topology is known. |
| Desktop pairing | COMPLETE (fixed) | Before: the device token was returned to anyone with the session id, forever; another account could re-approve; no expiry. Now: 15-minute TTL, 409 on re-approval, one-time pickup (410 afterwards). 5 tests, all fail on the old code. Agent `pairing.js` compatibility checked (stops after the first token, reads `deviceId`). |
| Device revocation | COMPLETE (new) | `DELETE /api/device/:deviceId`: owner only, deletes the token, clears pairing copies, closes the live socket (4003), audited. Live check: approve → pickup → 410 → revoke → list empty. |
| Device token storage | WARNING | Plaintext in `device_tokens` (service-role access only after the RLS migration). |
| Execution gateway / risk tiers | COMPLETE | GREEN/YELLOW/RED with approvals, role requirements, expiry, separation of duties (agentExecution + security suites; live E2E). Code not modified. |
| Execution evidence / audit log | COMPLETE | Evidence endpoints and audit trail tested in suites; live E2E reads them. |
| Sensitive-data filter | COMPLETE | Regression tests (incl. UUID false-positive fix L10-B1). Not modified. |
| Emergency stop / firewall | COMPLETE | Live E2E toggles emergency stop on/off. |
| Workflows | COMPLETE | 49 PG tests incl. restart recovery. Multi-instance requires `MULTI_INSTANCE_EXECUTION=true` (two workers on one DB without it caused the only flakiness seen). |
| Integrations | NOT CONFIGURED (by default) | Code + tests complete; off unless `INTEGRATIONS_ENABLED=true` + `INTEGRATION_ENCRYPTION_KEY`. Real Slack/GitHub/Drive/email accounts not validated (ledger EXTERNAL_VALIDATION). |
| Webhooks | COMPLETE (code) / NOT CONFIGURED (external) | Signed, encrypted secrets, tested; real delivery over public https not validated. |
| Monitoring / revenue suite | COMPLETE | Revenue suite 50/50 in PG mode; local load test. |
| Billing / metering | COMPLETE (metering) / NOT CONFIGURED (payments) | Meters + plan limits tested; Stripe checkout only when `STRIPE_*` variables are set; never faked. |
| `/metrics` | COMPLETE | Disabled unless `METRICS_TOKEN` (≥ 32 chars); 401 without token. |
| Config check | COMPLETE | `node scripts/check-config.js` with an empty env → "7 error(s), 6 warning(s) — NOT ready for production" (expected; names only). |
| `.env.example` | COMPLETE (new) | Names only. |
| Dependencies | WARNING | `npm audit` (report only): 1 critical (protobufjs via `@xenova/transformers`, needs a major upgrade), 13 high, 18 moderate, 1 low. Patch-level lockfile updates applied within existing ranges (axios, multer, form-data, proxy-addr, websocket-driver). |

## 4. Supabase / database

| Item | Status | Evidence |
|---|---|---|
| Layer 1–10 migrations | COMPLETE | Fresh DB: 11 up migrations apply; all 11 down migrations leave 0 tables. |
| RLS on SaaS tables | COMPLETE | Layer migrations enable RLS. |
| RLS on legacy tables | COMPLETE (fixed) | Before: legacy tables (`device_tokens`, `pairing_sessions`, …) had no RLS; with Supabase's default grants the **public anon key could read device tokens** (reproduced). Migration `20261003_legacy_tables_rls` enables RLS everywhere, revokes anon/authenticated, and restricts public functions to `service_role`. After: "permission denied". Idempotent (applied twice, 67-table data snapshot identical). |
| Schema audit | COMPLETE | `scripts/schema-audit.sql` → 0 violations; now also flags any public table without RLS or with anon/authenticated grants (verified by deliberate regressions). |
| Production DB applied | INCOMPLETE | The migration must be applied to the real Supabase project by the owner (not reachable from here). |

## 5. Frontends

| Item | Status | Evidence |
|---|---|---|
| `mcis/frontend` | COMPLETE (untouched) | 14 suites, 64/64 tests; build "Compiled successfully". Ships an unused `@supabase/supabase-js` dependency (WARNING; no key exposure). `npm audit`: 3 critical / 74 high in the CRA build chain (WARNING). |
| `nexus-web` | COMPLETE (new) | 10 sections (Dashboard, AI Agents, Tasks, Workflows, Approvals, Integrations, Activity, Usage & Billing, Team, Settings) on real APIs; loading/empty/error/success states; responsive (no horizontal overflow at 390 px on any page — checked with Chromium). 33 unit/UI tests; build OK (~87 KB gzip + lazily loaded Firebase chunk). Live E2E 8/8 against a real backend + PostgreSQL. `npm audit`: 4 high via firebase → `@grpc/grpc-js` (server-side code path, not in the browser bundle). |
| Browser secrets | COMPLETE | Only public `VITE_FIREBASE_*` config; the console never talks to Supabase; the API client refuses non-`/api/` paths and sends the token only to the configured API. |

## 6. Nexus engine (`nexus/`) and desktop agent

| Item | Status | Evidence |
|---|---|---|
| Source unchanged | COMPLETE | `git diff f2be39b -- nexus mcis-agent` is empty. |
| Voice / "Hey MCIS" / transcription | INCOMPLETE (not re-verified here) | Code unchanged. The 31/31 voice checksum script and Windows-only tests need the owner's Windows machine, which was not reachable this session. |
| Python tests | INCOMPLETE | Linux: 10 failed / 59 passed out of the box because `python-dotenv` is missing from `requirements.txt`; with it, 5 failed / 64 passed / 80 errors (Windows-only modules: `winreg`, `pywin32`, Playwright browsers). Authoritative run: Windows (`py -m pytest -m "not live" -q`). |
| `requirements.txt` | WARNING | Missing `python-dotenv`, `win10toast`; `tests/test_execution_pipeline.py` imports the non-existent `browser.intelligence.action_model`. |
| `api_server.py` bridge auth | BLOCKING (for shipping the engine to customers) | Accepts unauthenticated requests when `NEXUS_DEVICE_TOKEN` is unset (line 22–28), binds `0.0.0.0:8000` (line 123), compares with `!=`. Not changed under the "don't modify Nexus" constraint. Backend `check-config` already requires the token when `NEXUS_URL` is set. |
| Agent pairing compatibility | COMPLETE | See §3. |

## 7. Commercial readiness

| Item | Status |
|---|---|
| Usage metering per workspace | COMPLETE |
| Plan limits | COMPLETE (enforced only when `BILLING_ENABLED=true`; otherwise metering only — shown as such in the console) |
| Payments (Stripe) | NOT CONFIGURED |
| Invitation email | NOT CONFIGURED (one-time invite codes are shown instead — verified live) |
| Onboarding / templates | COMPLETE (feature flags) |
| Production capacity | INCOMPLETE (measured on a test machine only) |

## 8. Limitation ledger

`mcis/backend/docs/LAYER10_LEDGER.{md,json}`: 58 CLOSED · 11 EXTERNAL_VALIDATION ·
26 INTENTIONALLY_UNSUPPORTED · 6 REMAINING (F-R1…F-R6, added by this audit).
