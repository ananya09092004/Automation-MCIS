# Nexus — production runbook

Operational procedures for the Nexus backend (`mcis/backend`), web app
(`mcis/frontend`) and database (Supabase / PostgreSQL). Settings are
described in `PRODUCTION_CONFIG.md`; design in the `LAYER*.md` documents.

Every command below prints setting **names**, counts and statuses — never a
secret value. Run them from `mcis/backend` with the production environment
loaded (never paste secrets into a shell history or a ticket).

---

## 1. Environment

1. Put every secret in the hosting provider's secret store. Required and
   conditional settings: `PRODUCTION_CONFIG.md` §1–2.
2. `node scripts/check-config.js` → must exit 0. It refuses, among others:
   `ALLOW_UNAUTHENTICATED_API=true`, a non-https or localhost
   `ALLOWED_ORIGINS`, an anon key as `SUPABASE_KEY`, a missing
   `INTEGRATION_ENCRYPTION_KEY` with integrations on, an old encryption key
   that reuses the current key id, `NEXUS_URL` without `NEXUS_DEVICE_TOKEN` or
   over plain http, a short `METRICS_TOKEN`, an invalid `USAGE_RETENTION_DAYS`,
   Google Drive without its OAuth client, incomplete Stripe settings.
3. Warnings to act on before go-live: `PERMISSIONS_ENFORCED` not `true`,
   Stripe test key on production, old encryption keys still loaded.

## 2. Database migrations

Order (each file is idempotent; each has a matching `.down.sql`):

```
20260923_layer1_workspaces      20260924_layer3_agent_executions
20260925_layer2_workspace_data_scoping    20260926_layer4_workflows
20260927_layer5_integrations    20260928_layer6_security
20260929_layer7_billing         20260930_layer8_customer
20261001_layer9_hardening       20261002_layer10_revenue
```

Apply with `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/<file>.up.sql`
(or the Supabase SQL editor), then reload the API schema cache
(`notify pgrst, 'reload schema';`). `pgcrypto` is optional (only core
`gen_random_uuid()` is used). Afterwards run the schema audit:

```
psql "$DATABASE_URL" -f scripts/schema-audit.sql   # prints ONLY violations
```

It checks that every Layer 1–9 table exists with RLS on, that `anon` /
`authenticated` hold no table privileges or policies, that workspace-owned
tables have a NOT NULL `workspace_id` covered by a foreign key and an index,
and that no Layer 1–9 RPC is executable by `public`/`anon`/`authenticated`.

**Rollback**: deploy the previous code first, then run the down files in
reverse order down to the target layer. Down migrations keep every row of
earlier layers (Layer 9 down restores the Layer 7 ledger trigger verbatim;
rows already purged by retention cannot be restored).

## 3. Deploy

1. `node scripts/check-config.js` (exit 0).
2. Apply new migrations (§2) and the schema audit.
3. Deploy backend instances. Several API instances are supported
   (`MULTI_INSTANCE_EXECUTION` on by default: executions are owned through a
   lease; another instance never resumes or duplicates them).
4. Workflow workers: run the worker on one or more instances
   (`WORKFLOW_WORKER_ENABLED` default on; set `false` on API-only instances).
   Jobs are claimed with a fenced lease, so several workers are safe; a
   worker that loses its lease can no longer start or settle a step.
5. Deploy the frontend (`REACT_APP_API_URL` → backend).
6. Smoke test: `GET /health` (liveness), `GET /health/ready` (database +
   worker heartbeat counts), sign in, open `/workspace`.

## 4. Health checks and monitoring

| Endpoint | Use | Content |
|---|---|---|
| `GET /health` | liveness | uptime only |
| `GET /health/ready` | readiness | `database` ok/unavailable; `workers.live/stale/runningJobs` (counts only). 503 when the DB is down, or when `READINESS_REQUIRE_WORKERS=true` and no worker heartbeat is fresher than 60 s |
| `GET /metrics` | Prometheus scrape, `Authorization: Bearer $METRICS_TOKEN` | `nexus_http_requests_total{group,method,status}`, `nexus_http_request_duration_seconds` histogram, `nexus_workers_live/stale`, `nexus_worker_running_jobs`, `nexus_retention_sweeps_total`, uptime. Labels are route groups (e.g. `workspace:executions`) and status classes — never ids, users or payloads |

Every response carries `X-Request-Id` (a safe inbound id is kept, otherwise
one is generated); 500 responses include it as `requestId`, and it is in the
error log line. Ask customers for it when they report a problem.

Suggested alerts: readiness 503 for > 2 min; `5xx` rate > 2 % over 10 min;
p95 latency of `workspace:executions` > 2 s; `nexus_workers_live == 0` on
worker deployments; audit rows `security.worker_fenced` or
`security.policy_deny` spikes; `quota_exceeded` spikes (plan pressure);
retention sweep failures in the log.

Customer-facing observability (per workspace): `/workspace` overview and
`GET /api/workspaces/:id/overview` (Layer 8).

## 5. Secrets and key rotation

**Integration encryption key** (AES-256-GCM, per-record key id):
1. Generate a new key: `openssl rand -base64 32`.
2. Set `INTEGRATION_ENCRYPTION_KEY=<new>`, `INTEGRATION_ENCRYPTION_KEY_ID=<new id, e.g. k2>`,
   `INTEGRATION_ENCRYPTION_OLD_KEYS=<old id>:<old key>` and deploy (reads work with both keys, writes use the new one).
3. `node scripts/rotate-integration-keys.js --dry-run` → counts.
4. `node scripts/rotate-integration-keys.js` → re-encrypts every credential under the new key
   (compare-and-set per row; safe to run twice or concurrently). Exit code 2 if a row needs a key that is not loaded.
5. When `remainingUnderOldKeys` is 0, remove `INTEGRATION_ENCRYPTION_OLD_KEYS` and deploy.

**Workspace API keys**: owners rotate them in Security → API keys (the old
key stops working immediately; the new one is shown once).

**Provider secrets** (Stripe, GitHub/Google OAuth client secrets, Gemini,
Firebase service account, `NEXUS_DEVICE_TOKEN`, `METRICS_TOKEN`): rotate in
the provider console, update the secret store, redeploy. Stripe webhook
secret: roll it in the Stripe dashboard (Stripe signs with both during the
overlap), then update `STRIPE_WEBHOOK_SECRET`.

**OAuth tokens** of connected accounts are refreshed automatically when they
expire (GitHub App user tokens, Google Drive). A refresh failure marks the
integration as needing reconnection; the owner reconnects it.

**Secret scanning**: `node scripts/secret-scan.js` (repository; exit 1 on
findings, names/locations only) and `node scripts/secret-scan.js --db`
(legacy plaintext GitHub tokens, credentials without ciphertext, recent audit
rows and execution step evidence).

## 6. OAuth and payments setup

- **GitHub OAuth**: create an OAuth App (or GitHub App); callback
  `https://<api-host>/api/github/callback`; set `GITHUB_CLIENT_ID/SECRET/REDIRECT_URI`.
- **Google Drive** (read-only): Google Cloud console → OAuth client (web);
  authorised redirect URI `https://<api-host>/api/oauth/google_drive/callback`;
  enable the Drive API; OAuth consent screen with scope
  `https://www.googleapis.com/auth/drive.readonly` (Google requires app
  verification for this scope before external users can connect); set
  `GOOGLE_DRIVE_ENABLED=true` and `GOOGLE_OAUTH_*`. Owners connect Drive in
  Security → OAuth connections; the integration starts limited to "My Drive"
  root — widen `allowedFolders` in Integrations.
- **Stripe**: `PRODUCTION_CONFIG.md` §2 (products/prices, webhook endpoint,
  customer portal). Run the test-mode checklist below before live keys.

Test-mode checklist (Stripe test keys on staging): upgrade with card
`4242 4242 4242 4242` → webhook `customer.subscription.created` → plan shows
Pro; open "Manage subscription" (portal); cancel → `cancel_at_period_end`
confirmed by webhook; replay a webhook from the dashboard → acknowledged,
not re-applied; a failing card (`4000 0000 0000 0341`) → `past_due`.

## 7. Backup and restore

- Supabase: enable Point-in-Time Recovery (Pro plan and above) or daily
  backups; test a restore into a separate project quarterly.
- Restore procedure: restore to a new database → apply any migrations newer
  than the backup → run `scripts/schema-audit.sql` → point a staging backend
  at it → verify sign-in, workspaces, integrations (credentials decrypt only
  with the key ids that encrypted them — keep old keys in the secret store's
  history until every restored row has been rotated) → switch traffic.
- Integration credentials are encrypted with keys that are NOT in the
  database backup; losing the key means reconnecting integrations.

## 8. Data retention

- Owners set per-workspace retention in Workspace → Data retention
  (executions/runs ≥ 7 days, audit ≥ 90 days; empty = keep).
  `USAGE_RETENTION_DAYS` (≥ 35) applies to the usage ledger of all workspaces.
- Worker instances sweep every `RETENTION_SWEEP_MINUTES` (default 360); owners
  can also run "Apply now". Running/waiting work is never deleted; each purge
  is audited as `retention_purged` with counts only. The database enforces the
  floors again and only the purge function can delete ledger rows.

## 9. Incident response

1. **Contain**
   - One workspace misbehaving (runaway agent, suspected prompt injection,
     compromised member): an owner/admin turns on **Security → Emergency
     stop** (or `POST /api/workspaces/:id/security/emergency-stop {"active":true}`).
     Every agent and connector action in that workspace is denied before it is
     sent; waiting runs cannot continue.
   - The desktop bridge globally: the existing `/api/emergency/stop` (voice
     route) stops the local desktop agent.
   - Compromised API key: revoke it (Security → API keys).
   - Compromised integration credential: disconnect the integration and
     revoke the token at the provider.
   - Suspected server secret leak: rotate it (§5), redeploy.
2. **Investigate**: audit log (`/api/workspaces/:id/audit`, security events
   in Security), request ids in logs, `security.*` audit actions
   (`policy_deny`, `suspicious_tool_injection`, `worker_fenced`,
   `ssrf_blocked`, `credential_access_denied`).
3. **Recover**: runs in `needs_review` are resolved by a human (retry,
   skip or fail) — Nexus never re-sends an action whose outcome is unknown.
   Turn the emergency stop off.
4. **Communicate** to affected customers; record the timeline.

## 10. Feature flags

`INTEGRATIONS_ENABLED`, `GOOGLE_DRIVE_ENABLED`, `WORKFLOWS_ENABLED`,
`WORKFLOW_WORKER_ENABLED`, `BILLING_ENABLED`, `STRIPE_ENABLED`,
`ONBOARDING_ENABLED`, `TEMPLATES_ENABLED`, `SECURITY_FIREWALL_ENABLED`
(keep on), `PERMISSIONS_ENFORCED` (turn on), `WORKSPACE_DATA_SCOPING` (keep
on), `MULTI_INSTANCE_EXECUTION` (keep on). Each is described in
`PRODUCTION_CONFIG.md`; turning a feature off never deletes its data.

## 11. Scaling notes (measured locally — see LAYER9_HARDENING.md)

- The API tier is stateless apart from in-process Layer 3 runtimes, which
  are owned through database leases; add instances freely.
- One active agent execution per workspace (database-enforced); throughput
  scales with the number of workspaces and worker `maxConcurrent`.
- The main cost per workflow step is database round trips; size the
  PostgREST/Supabase connection pool accordingly.


## 12. Layer 10 — revenue suite operations

**Migration**: `20261002_layer10_revenue.up.sql` (requires Layers 1–9; idempotent;
rollback `.down.sql`, which deletes only Layer 10 rows and the two new usage
metrics' ledger rows, restores the original metric constraint and removes the
four new plan-limit keys). Run `scripts/schema-audit.sql` afterwards.

**Flags**: `REVENUE_SUITE_ENABLED` (default on), `REVENUE_WORKER_ENABLED`
(default on; the worker claims monitors, QA results and webhook deliveries with
leases, so it is safe on several instances). Monitoring of web pages, Slack and
email alerts need `INTEGRATIONS_ENABLED=true`; webhooks need
`INTEGRATION_ENCRYPTION_KEY` (the signing secrets are encrypted with it).

**Health**: `/health/ready` lists worker kinds (`workflow`, `revenue`).
`/metrics` adds `nexus_monitoring_checks_total`, `nexus_monitoring_changes_total`,
`nexus_monitoring_unavailable_total`, `nexus_monitoring_stale_total`,
`nexus_webhook_deliveries_total`, `nexus_webhook_failures_total`.

**Incidents**
* A site blocks automated access → its monitors turn UNAVAILABLE
  (`ACCESS_BLOCKED`); values are kept but shown as not current. Use an official
  feed / API (json_api via the HTTP connector) or API submissions instead.
* Slack webhook revoked → deliveries `failed AUTH_FAILED`, integration `revoked`;
  rotate the webhook URL in Integrations, then retry failed deliveries.
* Webhook endpoint down → deliveries back off (30 s·2ⁿ, ≤ 6 h), dead after 8
  attempts; the endpoint is disabled after 50 consecutive failures — fix it,
  set it active again in Developers → Webhooks, send a test.
* Emergency stop (Security) blocks monitoring checks and alert sends too.

**Mutation testing**: `node scripts/mutation-test.js` (40 mutations of Layer 10
checks; must report 0 survived).

**External validation checklist (needs real accounts; not done here)**
1. Slack: create an Incoming Webhook, connect it (Integrations → Slack), raise a
   test alert, confirm the message in the channel and `delivered` in Nexus.
2. Email: verify a sending domain in Resend or SendGrid, connect it with
   `alertRecipients`, raise a test alert; for invitations set
   `INVITE_EMAIL_PROVIDER/API_KEY/FROM` + `APP_BASE_URL` and invite a test user.
3. Web pages: add a real product page you are permitted to read (own store,
   partner) to a `web_page` integration's allowlist, check it, compare the
   observed price with the page. Marketplaces that forbid automated access
   must be integrated through their official APIs (json_api) instead.
4. Webhooks: register an https receiver, verify `Nexus-Signature` with the SDK.
