# Nexus — production configuration checklist

Check a server's configuration with:

```
cd mcis/backend
node scripts/check-config.js          # human-readable
node scripts/check-config.js --json   # machine-readable
```

It prints setting **names and a status only** (never a value) and exits with
code 1 when anything required is missing or invalid, or a development-only
switch is on. Run it before every deploy.

Secrets live only in the hosting provider's secret store (or a local `.env`
that is never committed). No real secret appears in this repository, its
docs or its tests; tests generate throw-away values at run time.

## 1. Required

| Setting | Area | Notes |
|---|---|---|
| `NODE_ENV=production` | runtime | Enables production auth behaviour. |
| `SUPABASE_URL` | database | `https://<project>.supabase.co` |
| `SUPABASE_KEY` | database | The **service-role** key (server only). The checker rejects an anon/authenticated key. |
| Firebase Admin credentials | auth | One of: `FIREBASE_SERVICE_ACCOUNT_JSON`, `FIREBASE_SERVICE_ACCOUNT_PATH`, `GOOGLE_APPLICATION_CREDENTIALS`, or `FIREBASE_PROJECT_ID` + `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY`. Verifies user sign-in tokens. |
| `ALLOWED_ORIGINS` (or `FRONTEND_URL`) | http | Comma-separated **https** origins of the web app. No `*`, no localhost on a production server. |
| `GEMINI_API_KEY` | agent | Planner model for agent executions. |
| `GROQ_API_KEY` | legacy | Loaded at start-up by legacy chat modules (the server does not boot without it). |

## 2. Required when a feature is on (conditional)

| Feature | Settings |
|---|---|
| Integrations (`INTEGRATIONS_ENABLED=true`) | `INTEGRATION_ENCRYPTION_KEY` — 32 random bytes, base64 or hex (`openssl rand -base64 32`). Optional `INTEGRATION_ENCRYPTION_KEY_ID`, `INTEGRATION_ENCRYPTION_OLD_KEYS` for rotation. |
| GitHub OAuth | `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` + `GITHUB_REDIRECT_URI` (all three). The same client id/secret refresh expiring GitHub App user tokens. |
| Google Drive (`GOOGLE_DRIVE_ENABLED=true`, needs `INTEGRATIONS_ENABLED=true`) | `GOOGLE_OAUTH_CLIENT_ID` + `GOOGLE_OAUTH_CLIENT_SECRET` + `GOOGLE_OAUTH_REDIRECT_URI` = `https://<api-host>/api/oauth/google_drive/callback`. Scope requested: `drive.readonly`. Access tokens expire after about an hour and are refreshed with the client secret. |
| Key rotation in progress | `INTEGRATION_ENCRYPTION_OLD_KEYS` must not reuse the current `INTEGRATION_ENCRYPTION_KEY_ID`; the checker warns while old keys are loaded (run `scripts/rotate-integration-keys.js`, then remove them). |
| Metrics (`METRICS_TOKEN` set) | At least 32 characters. `GET /metrics` is disabled (404) while it is unset. |
| Usage retention (`USAGE_RETENTION_DAYS` set) | 35-3650. Unset = the usage ledger is kept forever. |
| Desktop bridge (`NEXUS_URL` set) | `NEXUS_DEVICE_TOKEN` is then required; in production `NEXUS_URL` must be https or a loopback address. |
| Generic billing webhooks (`BILLING_PROVIDER=generic`) | `BILLING_WEBHOOK_SECRET` — at least 32 characters, shared with your billing system. |
| Stripe (`STRIPE_ENABLED=true`) | `STRIPE_SECRET_KEY` (`sk_live_…` or a restricted `rk_live_…`), `STRIPE_WEBHOOK_SECRET` (`whsec_…` of the endpoint below), at least one `STRIPE_PRICE_<PLAN>` (e.g. `STRIPE_PRICE_PRO`, `STRIPE_PRICE_BUSINESS` — Stripe *price* ids of monthly recurring prices), `APP_BASE_URL` (https URL of the web app, used for checkout/portal return links). A test-mode key on a production server is reported as a warning: no real payment is taken. |

Stripe dashboard setup:
1. Products → create Pro / Business with a monthly recurring price; copy the `price_…` ids.
2. Developers → Webhooks → add endpoint `https://<api-host>/api/billing/webhooks/stripe` with events
   `checkout.session.completed`, `checkout.session.expired`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`; copy its signing secret.
3. Settings → Billing → Customer portal: enable it (used by "Manage subscription").
4. Enterprise is **not** sold online: leave `STRIPE_PRICE_ENTERPRISE` unset and activate it with
   `node scripts/billing-set-plan.js --workspace <id> --plan enterprise --operator <you> [--limits '{…}']`.

## 3. Security switches (keep these values in production)

| Setting | Production value | Effect |
|---|---|---|
| `SECURITY_FIREWALL_ENABLED` | unset or `true` | Agent Firewall on (the server refuses values other than `true`/`false`). |
| `PERMISSIONS_ENFORCED` | `true` | First-time resource approval for the desktop agent. |
| `WORKSPACE_INVITES_REQUIRE_VERIFIED_EMAIL` | unset or `true` | Invitations need a verified email. |
| `WORKSPACE_DATA_SCOPING` | unset (on) | Chats / memory / goals are workspace-scoped. |
| `BILLING_ENABLED` | `true` once plans are assigned | Enforces plan limits (fail closed). `false` = metering only. |

## 4. Development-only (must be off in production)

| Setting | Why |
|---|---|
| `ALLOW_UNAUTHENTICATED_API=true` | Disables authentication entirely. The checker fails if it is set. |
| Stripe test-mode keys (`sk_test_…`) | Fine on staging; on production they take no real payments (warning). A **live** key on a non-production server is also reported. |

Layer 9: even if `ALLOW_UNAUTHENTICATED_API=true` is set by mistake, the server
**ignores it when `NODE_ENV=production`** (authentication stays on and an error is logged).

## 5. Optional

| Setting | Default | Notes |
|---|---|---|
| `PUBLIC_API_URL` | – | Public API base URL shown in the API documentation (`/developers`). |
| `ONBOARDING_ENABLED` | on | `false` hides guided onboarding; existing users are unaffected either way. |
| `TEMPLATES_ENABLED` | on | `false` turns off workflow templates. |
| `WORKFLOWS_ENABLED`, `WORKFLOW_WORKER_ENABLED` | on | Layer 4 routes / worker. |
| `MULTI_INSTANCE_EXECUTION` | on | Lease-based execution ownership for several server instances. |
| `BILLING_PAST_DUE_GRACE_DAYS` | 7 | Grace period after a failed renewal. |
| `NEXUS_URL` + `NEXUS_DEVICE_TOKEN` | – | Desktop execution bridge; the token must equal the one in `nexus/.env`. |
| `GOOGLE_DRIVE_ENABLED` | off | Read-only Google Drive connector (see section 2). |
| `METRICS_TOKEN` | – | Enables `GET /metrics` (Prometheus text) for a scraper that sends `Authorization: Bearer <token>`. |
| `READINESS_REQUIRE_WORKERS` | false | `GET /health/ready` returns 503 when no workflow worker has a fresh heartbeat. Set `true` on worker instances' health checks. |
| `RETENTION_SWEEP_MINUTES` | 360 | Interval of the retention sweep on worker instances (`0` = off, minimum 5). |
| `USAGE_RETENTION_DAYS` | – (keep) | Deletes usage-ledger rows older than this (35-3650 days). |
| `APP_VERSION` | – | Reported with worker heartbeats. |
| `PORT` | 5051 | |
| Legacy AI/media keys (`COHERE_API_KEY`, `PINECONE_*`, `SERPER_API_KEY`, `CLOUDINARY_*`, `JUDGE0_*`) | – | Only for the legacy chat / coding features that use them. |

## 6. Database

Apply the migrations in order (each has an idempotent `up` and a `down`):
`20260923_layer1` → `20260924_layer3` → `20260925_layer2` → `20260926_layer4` →
`20260927_layer5` → `20260928_layer6` → `20260929_layer7` → `20260930_layer8` →
`20261001_layer9`. Every Layer 1–9 table has RLS on with no client policies;
`anon` / `authenticated` have no privileges on them — the backend uses the
service-role key. Verify with `psql -f scripts/schema-audit.sql` (prints only
violations). The migrations use only core `gen_random_uuid()`: `pgcrypto` is
created when the server offers it and is not required.

## 7. Frontend

| Setting | Notes |
|---|---|
| `REACT_APP_API_URL` | Backend base URL. |
| Firebase web config | Public by design (it identifies the project; it is not a secret). |

No payment or server secret is ever sent to the browser: the web app only
receives Stripe-hosted checkout / portal URLs from the backend.


## 8. Layer 10 settings

| Setting | Default | Notes |
|---|---|---|
| `REVENUE_SUITE_ENABLED` | on | `false` turns off competitor intelligence, monitoring, alerts, agent QA, AI workforce, webhooks and workspace export/delete routes and the revenue worker. |
| `REVENUE_WORKER_ENABLED` | on | `false` on instances that must not run scheduled checks / QA runs / webhook deliveries. Lease-based; several instances are safe. |
| `INTEGRATIONS_ENABLED` | off | Needed for web-page monitoring and Slack / email alert channels. Without it monitors accept API submissions only and alerts are in-app. |
| `INTEGRATION_ENCRYPTION_KEY` | — | Also encrypts webhook signing secrets; webhooks cannot be created without it. |
| `INVITE_EMAIL_PROVIDER` | unset | `resend` or `sendgrid` — enables invitation emails. |
| `INVITE_EMAIL_API_KEY` | — | Provider API key (server only, never returned or logged). |
| `INVITE_EMAIL_FROM` | — | Sender address verified with the provider. |
| `APP_BASE_URL` | — | Web app URL used in invitation links (`/workspace#invite=<code>`). |

`node scripts/check-config.js` reports all of them (names only, never values).
