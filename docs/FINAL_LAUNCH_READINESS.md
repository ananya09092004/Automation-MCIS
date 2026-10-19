# Final launch readiness — Automation-MCIS / Nexus

**Verdict: demo-ready and pilot-ready for a supervised web-only pilot. NOT production-ready**
for self-serve paying customers or for distributing the desktop engine, because of the
blockers in §3. Details: `docs/FINAL_ENGINEERING_AUDIT.md`.

Verification environment: Linux cloud workspace, PostgreSQL 16 + PostgREST (Supabase-style
roles and default grants simulated), Firebase Auth emulator mode, Chromium. Windows-only
parts (voice, desktop automation) could not be run here.

## Verification matrix

| Item | Result | Evidence |
|---|---|---|
| Backend starts | PASS | dev and `NODE_ENV=production` |
| `/health`, `/health/ready` | PASS | 200 / 200 |
| Database connectivity | PASS | readiness + all PG-mode suites |
| Supabase migrations (up / down / idempotent) | PASS | fresh DB; RLS migration applied twice with identical data |
| RLS / workspace isolation | PASS | schema audit 0 violations; anon key denied; cross-workspace → 404 |
| Authentication | PASS | missing / forged token → 401; dev bypass refused in production |
| Authorization (roles) | PASS | member → 403 on admin actions (live) |
| Agent execution | PASS | 37 PG tests; live "Ask Nexus" creates a real execution |
| Task planner / recovery (Nexus engine) | WARNING | unchanged; Python suite needs Windows to run cleanly |
| Browser automation | WARNING | unchanged; needs Windows + Playwright browsers |
| Desktop automation | WARNING | unchanged; needs Windows |
| Voice / "Hey MCIS" | WARNING | unchanged (git diff empty); 31/31 checksum must be re-run on the owner's machine |
| Permissions / risk controls (GREEN/YELLOW/RED) | PASS | suites + live approvals |
| Audit log / execution evidence | PASS | suites + live |
| Workflows | PASS | 49 PG tests incl. restart recovery |
| Integrations | NOT CONFIGURED | code PASS (34 PG tests); needs `INTEGRATIONS_ENABLED` + provider accounts |
| Monitoring (revenue suite) | PASS | 50 PG tests |
| Webhooks | WARNING | signed + tested locally; real https delivery not validated |
| Billing / metering | PASS (metering) | 22 PG tests; console shows real meters |
| Payments | NOT CONFIGURED | no `STRIPE_*`; console says "Not configured" |
| Nexus console build | PASS | `npm run build` |
| Nexus console → backend | PASS | live E2E 8/8 |
| Existing `mcis/frontend` intact | PASS | no diff; 64/64 tests; build OK |
| Existing tests | PASS | backend 406/406, SDK 11/11, frontend 64/64, nexus-web 33/33 |
| Production configuration | WARNING | `check-config` lists what is missing; values must be set by the owner |
| Docker / CI | NOT CONFIGURED | none in the repository |

## 1. What is working

- Multi-tenant workspaces, roles, invitations (one-time codes), ownership transfer.
- Agent executions with risk tiers, approvals, cancellation, evidence and audit trail.
- Workflows (versions, typed inputs, scheduled/API triggers, approvals, crash recovery).
- Security dashboard, firewall, emergency stop, sensitive-data filtering.
- Usage metering, plan limits (when enabled), monitoring/revenue suite, signed webhooks.
- Desktop pairing with expiry, one-time token delivery and revocation (new).
- Correct 4xx responses for bad origin / bad JSON (new); RLS on every public table (new).
- The Nexus web console (new) on all of the above.
- The original MCIS app, unchanged.

## 2. What is not working / not verified

- Nexus Python test suite is not clean outside Windows; `requirements.txt` is incomplete.
- Voice, browser and desktop automation were not re-run in this pass (unchanged code).
- No payments, no invitation email, no third-party connector accounts configured.
- No CI pipeline or container build.

## 3. Launch blockers

1. **Nexus bridge fails open** (`nexus/api_server.py`): unauthenticated when
   `NEXUS_DEVICE_TOKEN` is unset, listens on `0.0.0.0:8000`. Blocks shipping the engine to
   customer machines. Fix: fail closed, bind `127.0.0.1`, `hmac.compare_digest`.
2. **Apply migration `20261003_legacy_tables_rls.up.sql` to the production Supabase
   project.** Until then the public anon key can read legacy tables (incl. device tokens).
3. **Production configuration**: `node mcis/backend/scripts/check-config.js` must report 0
   errors on the production server.
4. For paid self-serve only: payments are NOT CONFIGURED.

## 4. Warnings

- Desktop screenshots with personal details and a 3 MB git bundle are committed (`nexus/screen.png`, `nexus/desktop_test.png`, `nexus-layer1-checkpoint.bundle`).
- Device tokens stored in plaintext; no global API rate limit; pairing endpoints unlimited; `trust proxy` unset.
- `npm audit`: backend 1 critical + 13 high; `mcis/frontend` (CRA) 3 critical + 74 high; nexus-web 4 high (not in the browser bundle).
- `DEBUG allowedOrigins` console log in `server.js`.
- More than one backend instance requires `MULTI_INSTANCE_EXECUTION=true`.
- Production capacity measured on a test machine only.

## 5. External / provider / customer configuration

- Supabase: apply all migrations; run `scripts/schema-audit.sql` (expect 0 rows).
- Firebase: production project, authorised domains for the console and MCIS app, email verification on.
- Hosting: backend over https; console origin in `ALLOWED_ORIGINS`; SPA rewrite for `nexus-web/dist`.
- Stripe (optional): products/prices, webhook endpoint + secret.
- Email (optional): verified sending domain with Resend or SendGrid.
- Connectors (optional): Slack / GitHub / Google Drive OAuth apps and redirect URIs.
- Desktop: Windows build of the agent + Nexus engine with `NEXUS_DEVICE_TOKEN` set.

## 6. Ready for a real demo

Yes: the Nexus console (dashboard, Ask Nexus, approvals, workflows, team, billing truth,
emergency stop) against a running backend, plus the MCIS app and voice on the owner's
Windows machine.

## 7. Ready for a pilot customer

Yes, for a **supervised web pilot** once blockers 2 and 3 are done: workspaces, agents,
approvals, workflows, metering, audit. Desktop execution only on machines you control with
`NEXUS_DEVICE_TOKEN` set and port 8000 firewalled.

## 8. NOT production-ready

- Distributing the desktop engine/agent to customers (blocker 1).
- Paid self-serve sign-up (payments not configured).
- Horizontal scale claims (capacity unmeasured on production infrastructure).
- Third-party connectors until validated with real accounts.

## 9. Local commands

```bash
# Backend (port 5051)
cd mcis/backend
npm ci
cp .env.example .env            # fill in values; never commit .env
node scripts/check-config.js    # names only, no values printed
npm start
npm test                        # 406 tests

# Database (Supabase SQL editor or psql): apply migrations/*.up.sql in date order,
# then run scripts/schema-audit.sql — expect 0 rows.

# Nexus web console (port 5174, /api proxied to 5051)
cd nexus-web
npm ci
cp .env.example .env.local      # VITE_FIREBASE_* values
npm run dev
npm test                        # 33 tests
npm run build

# Original MCIS app
cd mcis/frontend && npm ci && npm start

# Nexus engine (Windows)
cd nexus && py -m pip install -r requirements.txt python-dotenv && py -m pytest -m "not live" -q
```

## 10. Environment variable names

**Backend** (`mcis/backend/.env.example`, full reference `mcis/backend/docs/PRODUCTION_CONFIG.md`):
`NODE_ENV`, `PORT`, `SUPABASE_URL`, `SUPABASE_KEY`, `ALLOWED_ORIGINS`, `GEMINI_API_KEY`,
`GROQ_API_KEY`, `FIREBASE_SERVICE_ACCOUNT_JSON` | `FIREBASE_SERVICE_ACCOUNT_PATH` |
`GOOGLE_APPLICATION_CREDENTIALS` | `FIREBASE_PROJECT_ID` + `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY`,
`SECURITY_FIREWALL_ENABLED`, `PERMISSIONS_ENFORCED`, `WORKSPACE_INVITES_REQUIRE_VERIFIED_EMAIL`,
`WORKSPACE_DATA_SCOPING`, `INTEGRATIONS_ENABLED`, `INTEGRATION_ENCRYPTION_KEY`,
`INTEGRATION_ENCRYPTION_KEY_ID`, `WORKFLOWS_ENABLED`, `REVENUE_SUITE_ENABLED`,
`REVENUE_WORKER_ENABLED`, `BILLING_ENABLED`, `ONBOARDING_ENABLED`, `TEMPLATES_ENABLED`,
`MULTI_INSTANCE_EXECUTION`, `STRIPE_ENABLED`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`STRIPE_PRICE_PRO`, `STRIPE_PRICE_BUSINESS`, `APP_BASE_URL`, `NEXUS_URL`, `NEXUS_DEVICE_TOKEN`,
`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_REDIRECT_URI`, `GOOGLE_DRIVE_ENABLED`,
`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`,
`INVITE_EMAIL_PROVIDER`, `INVITE_EMAIL_API_KEY`, `INVITE_EMAIL_FROM`, `PUBLIC_API_URL`,
`METRICS_TOKEN`, `READINESS_REQUIRE_WORKERS`, `RETENTION_SWEEP_MINUTES`, `USAGE_RETENTION_DAYS`,
`APP_VERSION`. Development only: `ALLOW_UNAUTHENTICATED_API` (ignored in production).

**Nexus web console**: `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`,
`VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`, `VITE_FIREBASE_STORAGE_BUCKET`,
`VITE_FIREBASE_MESSAGING_SENDER_ID`, `VITE_API_URL`; dev only `NEXUS_DEV_API_TARGET`.

**MCIS app**: `REACT_APP_API_URL`, `REACT_APP_BACKEND_URL`, `REACT_APP_FIREBASE_API_KEY`,
`REACT_APP_FIREBASE_AUTH_DOMAIN`, `REACT_APP_FIREBASE_PROJECT_ID`, `REACT_APP_FIREBASE_APP_ID`,
`REACT_APP_FIREBASE_STORAGE_BUCKET`, `REACT_APP_FIREBASE_MESSAGING_SENDER_ID`,
`REACT_APP_FIREBASE_MEASUREMENT_ID`.

**Desktop agent**: `MCIS_BACKEND_HTTP_URL`, `MCIS_FRONTEND_URL`, `VOSK_MODEL_PATH`,
`MCIS_MIC_GAIN`, `MCIS_VAD_THRESHOLD`, `MCIS_AGENT_OWN_VOICE`.

**Nexus engine**: `NEXUS_DEVICE_TOKEN`, `NEXUS_VOICE_DEVICE_TOKEN`, `MCIS_BACKEND_HTTP_URL`, `GROQ_API_KEY`.
