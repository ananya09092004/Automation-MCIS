# Layer 10 — Revenue product suite

Competitor intelligence for e-commerce sellers, a generic monitoring engine with
alerts, AI-agent QA / reliability testing, an AI workforce (named agents + human
review), 17 executable workflow templates, an extended execution API with signed
webhooks and a JS SDK, invitation emails, workspace export / delete, and billing
for the new usage dimensions.

Everything is built **on** Layers 1–9: the same workspace context (non-members
get 404), the same Layer 3 execution service, Layer 4 runner, Layer 5 gateway,
Layer 6 Agent Firewall and API keys, Layer 7 entitlements and usage ledger,
Layer 9 retention, worker health and metrics. There is no second engine and no
path around the firewall.

Migration: `migrations/20261002_layer10_revenue.up.sql` (rollback `.down.sql`).
Flags: `REVENUE_SUITE_ENABLED` (default on), `REVENUE_WORKER_ENABLED` (default on,
safe on several instances). See PRODUCTION_CONFIG.md and PRODUCTION_RUNBOOK.md §12.

---

## 1. Monitoring engine (`services/revenue/monitoringService.js`)

```
monitor (source + schedule)
  → check: connector action through prepareAction → firewall (plan) → firewall (execute, single-use ticket) → gateway
  → deterministic extraction (JSON-LD, microdata, product meta tags, Shopify JSON, JSON Pointers) — never free text, never an LLM
  → normalized observation (VERIFIED / UNVERIFIED / UNAVAILABLE), secrets redacted
  → de-duplicated snapshot (value hash) → deterministic changes → events
```

| Source type | Kinds | How it is read |
|---|---|---|
| `web_page` | product, page | `web_page.fetch_product` (read-only, GREEN) on an allow-listed host |
| `shopify_product` | product | `/products/<handle>.js` (minor units) or `.json` (decimals), variant / SKU selection |
| `json_api` | api_value, product | `web_page.fetch_json` or the authenticated `http.get` + JSON Pointers |
| `api_submission` | any | values pushed with `POST /api/automation/v1/monitoring/monitors/:id/observations` (scope `monitoring:write`) — **always UNVERIFIED** |

Health: `PENDING → VERIFIED | UNVERIFIED | UNAVAILABLE | STALE`.

* A failed or blocked check never changes `current`; the monitor becomes
  UNAVAILABLE and `currentIsFresh=false` (the UI greys the old value).
* A structured page without a price is UNVERIFIED (`price` is `null`, never 0).
* A page without structured data is UNAVAILABLE `NO_STRUCTURED_DATA`.
* 404 / 410 → `present:false` (VERIFIED) → `product_disappeared`.
* STALE: no success within `staleAfterMinutes`; `source_stale` once per episode.
* Stock transitions only between known states: `UNKNOWN` never produces
  out-of-stock or back-in-stock.
* Prices in different currencies are never compared.
* Check keys make every check idempotent (worker: `check:<monitor>:<lease fence>`;
  manual: the request's Idempotency-Key; API: `api:<key>`), metered once as a
  `monitoring_check`; a check that never reached the source (blocked by the
  firewall, disconnected integration) is not charged.
* Worker: `claim_due_monitors` (SKIP LOCKED, lease + fence). A result whose
  lease was taken over is recorded but never applied (`leaseLost`).

Change types: price_decrease, price_increase, price_restored, new_discount,
discount_removed, seller_changed, out_of_stock, back_in_stock, limited_stock,
stock_changed, product_disappeared, product_reappeared, value_changed,
source_unavailable, source_recovered, source_stale.

## 2. Connectors added (`services/integrations/connectors/`)

| Provider | Action | Risk | Default | Notes |
|---|---|---|---|---|
| `web_page` | fetch_product, fetch_json | GREEN, read-only | on | host allowlist (exact / `*.suffix`, public only), SSRF-safe client, 3 redirects re-validated, size / type limits; returns structured fields + sha256 content hash only |
| `slack` | notify | GREEN | on | Incoming Webhook (bound by Slack to one channel), URL validated and encrypted; 404/403/410 → `AUTH_FAILED` → integration `revoked` |
| `slack` | post_message | YELLOW | off | free text written by an agent step |
| `email` | notify | GREEN | on | Resend or SendGrid; only the admin-fixed `alertRecipients` |
| `email` | send_email | YELLOW | off | one recipient in `allowedRecipientDomains` |
| `http` | get / post_json | (existing) | | new `headers` input: custom headers only (no auth, cookie, host, proxy, forwarding, hop-by-hop, CR/LF, or the configured auth/idempotency header) |

Sends are never retried automatically (a retry could send twice).
Server-initiated actions (checks, alert deliveries, QA probes) use
`services/actions/connectorActions.js`: APPROVAL_REQUIRED is reported as
`blocked` (never executed); with the firewall off only GREEN actions run.

## 3. Competitor intelligence (`competitorService.js`, `matching.js`, `margin.js`)

* **Products** (admin): SKU (unique per workspace), GTIN (GS1 check digit
  enforced, stored as GTIN-14), MPN, brand, model, marketplace ids, known URLs,
  currency, cost, selling price, fixed fees, fees %, target / minimum margin,
  optional own-listing monitor. Plan limit `max_monitored_products` is
  race-free (`enforce_monitored_product_limit` removes an over-limit insert).
* **Matching** (deterministic): GTIN 0.99, marketplace id 0.97, known URL 0.97,
  brand+MPN 0.95 → VERIFIED; brand+model 0.85, SKU 0.70, title ≤ 0.60 →
  UNVERIFIED; any conflict (different valid GTINs, brands, MPNs) → confidence 0.
  Identifiers observed on the page refine an undecided match; a human
  confirm / reject is final.
* **Margin**: complete only with cost AND configured fees (0 is a
  configuration; "not set" is not); otherwise the result lists what is missing.
  Margin impact uses only fresh prices of VERIFIED matches in the product's
  currency; excluded competitors are counted and shown.
* **Recommendations**: only from VERIFIED changes on VERIFIED matches —
  `review_pricing` (gap + margin if matched), `investigate_margin` (matching
  would breach the minimum), `review_promotion` (competitor out of stock / new
  discount), `monitor_competitor` (listing gone). `autoPricing:false` always.
  Acting on one creates a Layer 2 task or starts a Layer 4 run (its steps pass
  the firewall and approvals). Nothing changes a price by itself.

## 4. Alerts (`alertService.js`)

Rules (admin): price_below (crossing only), price_drop_pct, out_of_stock,
back_in_stock, margin_below (product-scoped; never on incomplete margins),
product_disappeared, source_stale, source_unavailable, any_change — scoped to a
monitor, a product (VERIFIED competitors only) or the workspace. De-duplicated
per (rule, change), throttled by `cooldownMinutes`.

Channels: in-app (the alert row), Slack `notify`, email `notify`. Each delivery
stores `delivered / failed / blocked / skipped / pending` with the error code.
Admins can retry a failed or blocked delivery (atomic claim: a double click
sends once). A delivery left `pending` by a crash becomes `failed INTERRUPTED`
and is never re-sent automatically. Webhooks subscribed to `alert.created` get
every alert.

## 5. AI workforce (`agentService.js` + Layer 3/4/2 hooks)

* Agents: name, role (research, data, spreadsheet, reviewer, custom),
  description, standing instructions, `maxRisk`, `allowedIntegrationIds`,
  active / archived. `POST /agents/defaults` creates the four standard agents
  (idempotent).
* Executions accept `agentId` (app route, tasks, workflow steps): `agent_id` is
  recorded, instructions are prefixed to the planner goal (sanitized), and the
  agent's limits are enforced at plan AND execute time **in addition to** the
  firewall: above `maxRisk` or outside the allowed integrations → DENY (even
  with an approval). Agents always act as the person who started the work.
* Tasks can be assigned to a named agent; executing the task runs as it.
* Workflow steps: `agentId` (checked at publish) and `type: "review"` — the run
  pauses (`needs_review`, `HUMAN_REVIEW`); a reviewer with `reviewerRole`
  (member / admin) approves (note becomes the step output, verification
  "human") or rejects (`REVIEW_REJECTED`).
* Workflow connector inputs may now hold ONE level of named scalars (e.g. a
  POST body) with templates; taint tracking covers them.

## 6. Templates (17)

Existing 8 + invoice_to_spreadsheet, email_order_extraction, crm_update
(approved POST), daily_business_report (→ Slack), document_generation (human
review), document_organization (approved moves), delayed_order_report
(→ email), recurring_business_summary (for schedules),
multi_agent_research_pipeline (Research → Data → Spreadsheet → human review,
bound to this workspace's agents; `AGENT_REQUIRED` otherwise). Each template
view derives permissions, expected evidence, failure and retry behaviour from
its steps.

## 7. Agent QA / reliability (`qaService.js`, `qaVerifier.js`)

Projects → suites → scenarios (executor `nexus_agent`, `workflow`,
`external_agent`), expected spec: outcome (success / failure / blocked),
expectedFailureCode, mustContain / mustNotContain, requireVerified,
requiredActions / forbiddenActions, maxDurationSeconds, and an independent
read-only probe through the gateway + firewall.

Runs create one result per scenario; the worker (`claim_qa_result`) starts each
with the stable key `qa:<resultId>`, polls without blocking, applies the
scenario timeout, and scores from the stored execution / run and its evidence.
External agents submit their report with scope `qa:run` (scored once;
replays return the first verdict). Categories: WRONG_ACTION, WRONG_DATA,
NAVIGATION_FAILURE, SELECTOR_FAILURE, TIMEOUT, AUTHENTICATION_FAILURE,
PERMISSION_FAILURE, POLICY_DENIAL, PROMPT_INJECTION, INCOMPLETE_TASK,
FALSE_SUCCESS, VERIFICATION_MISMATCH, EXTERNAL_SOURCE_UNAVAILABLE,
CONNECTOR_FAILURE, UNKNOWN — each with the rule and evidence that chose it.
Metrics (pass rate, categories, durations, verified %, evidence completeness,
retries / recovery, policy denials, injection detections, flaky scenarios,
trend) are computed from stored results only. Plan limit
`agent_test_scenarios_per_month` is checked before a run starts and metered
per started scenario.

## 8. Execution API, webhooks, SDK

New scopes: `qa:run`, `qa:read`, `monitoring:read`, `monitoring:write`,
`usage:read`. New endpoints (all documented in `/openapi.json`, parity tested):
`GET /executions/:id/evidence`, `GET /runs/:id/evidence`,
`POST /qa/projects/:id/runs`, `GET /qa/runs/:id`,
`POST /qa/runs/:id/results/:resultId`, `GET /qa/projects/:id/metrics`,
`GET /monitoring/monitors[/:id]`, `POST /monitoring/monitors/:id/observations`,
`GET /monitoring/changes`, `GET /monitoring/alerts`,
`GET /competitors/dashboard`, `GET /usage`.

Webhooks (admin, ≤10 per workspace): https + public DNS names only; secret
`whsec_…` shown once, stored AES-256-GCM encrypted (AAD bound to the webhook);
events execution.completed/failed, workflow_run.completed/failed,
alert.created, monitor.changed, recommendation.created, qa_run.completed.
Outbox `webhook_deliveries` (unique per event id), lease-claimed, signed
`Nexus-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`, no
redirects, backoff 30 s·2ⁿ (≤ 6 h), dead after 8 attempts, endpoint disabled
after 50 consecutive failures.

SDK: `mcis/sdk/js` (`NexusClient`, `verifyWebhookSignature`), tested against a
local API stand-in and the backend's own signer.

## 9. Billing / usage

New capabilities (`optional`: a plan row WITHOUT the key is unlimited so custom
plans created earlier keep working; a present but invalid value fails closed):

| Capability | Kind | Plan key | free / pro / business / enterprise |
|---|---|---|---|
| monitoring_checks | metered `monitoring_check` | monitoring_checks_per_month | 3000 / 60000 / 600000 / ∞ |
| agent_test_scenarios | metered `agent_test_scenario` | agent_test_scenarios_per_month | 100 / 2000 / 20000 / ∞ |
| monitored_products | count | max_monitored_products | 10 / 100 / 1000 / ∞ |
| integrations | count | max_integrations | 3 / 10 / 50 / ∞ |

These are LIMITS only; no price is set or invented (display prices remain
operator-configured).

## 10. Workspace lifecycle, invitations, retention

* `GET /lifecycle/export` (owner): every layer's data, secrets removed by safe
  views AND a key scrub, 10 000 rows per section with `truncated` flags.
* `POST /lifecycle/delete` (owner, team workspaces): type the name; refused
  with an active online subscription (`SUBSCRIPTION_ACTIVE`) or a running
  execution; purges the workspace's audit rows, deletes the workspace (every
  table cascades — Layer 10 references use `NO ACTION DEFERRABLE INITIALLY
  DEFERRED` so the cascade completes), invalidates the firewall cache and
  writes ONE content-free audit row.
* Invitation emails (optional): `INVITE_EMAIL_PROVIDER`, `INVITE_EMAIL_API_KEY`,
  `INVITE_EMAIL_FROM`, `APP_BASE_URL`; link `…/workspace#invite=<code>` (code
  in the fragment). The response says `sent / failed / not_configured`.
* Retention: monitoring history and finished QA runs follow the workspace's
  `executionsDays` (7-day floor; latest observation and current snapshot kept).

## 11. Frontend

`/competitors`, `/monitoring`, `/reliability`, `/workforce`, webhooks panel in
`/developers`, new meters in `/billing`, invitation links in `/workspace`.
Every page has loading / empty / error states and shows stale / unavailable
sources as such; admin-only actions are hidden for members (the server
enforces them anyway).

## 12. Verification (final, on the local machine)

| Check | Result |
|---|---|
| `npm test` (12 suites, memory stores) | 395 / 395 |
| `__tests__/revenue.test.js` memory / PostgreSQL + PostgREST | 50 / 50 and 50 / 50 |
| Layer 1–9 suites on PostgreSQL | 44, 37, 28, 49, 34, 35, 22, 26, 29, 15 — all pass |
| Mutation testing (`scripts/mutation-test.js`, 43 mutations) | 43 killed |
| Migration up → up → down → down → up; Layer 1–9 data snapshot (pre-existing columns) | identical; Layer 10 rows survive a re-run; fresh chain of all 10 layers up and down to 0 tables |
| `scripts/schema-audit.sql` (RLS, grants, workspace FKs / indexes, function grants) | 0 violations |
| Workspace delete with Layer 10 rows (deferred FKs) | cascades |
| Load memory: 200 monitors / 4 workers | ~300 checks/s, p95 ~20 ms |
| Load PostgreSQL: 200 monitors; 400 submissions (25 % duplicate keys, concurrency 25) | ~25 checks/s p95 189 ms; 200 alerts for 200 price drops; exactly one observation per key; no MONITOR_CONFLICT |
| Server start-up (dev, production with a dev switch set, integrations + key) | boots; revenue routes 401 without auth; dev switch ignored in production |
| Frontend (jest) / production build | 64 / 64 (14 suites); compiled successfully |
| SDK | 11 / 11 |
| Secret scan (repository + every test response, audit row, prompt, log) | clean |

Numbers describe the test machine; they are not a production capacity claim.

## 13. Bugs found and fixed while verifying

* **UUIDs redacted as Aadhaar numbers** (`backend-routing/sensitiveDataFilter.js`):
  ~0.3 % of random UUIDs end in 12 digits starting 2–9 and were partly
  replaced by `[REDACTED]` wherever payloads are sanitized (audit rows,
  evidence, webhook payloads). The Aadhaar / card patterns no longer match
  inside a larger token; real numbers are still redacted (P10-1).
* **Late job claim after `stop()`** (`services/workflows/workflowRunner.js`):
  a claim that resolved after the runner stopped was still driven by that
  instance; the live instance then reconciled its executions as
  SERVER_RESTART. This was the root cause of the Layer 9 flake L9-N6. The
  job is now handed back (graceful stop) or left to expire (crash) (P16-2).
* **Workspace delete cascade** (migration): Layer 10 references first used
  `ON DELETE RESTRICT`, which aborted deleting a workspace that had
  competitor monitors; they are `NO ACTION DEFERRABLE INITIALLY DEFERRED`.
* **Server start-up crash** (`routes/revenue.js`, found by the local
  start-up smoke): the webhook credential service was created without a
  store and threw "credential store is required", so `node server.js`
  exited whenever the revenue suite was on (the default). It now gets a
  store that refuses every call (webhooks only encrypt / decrypt) (P25-1).
* **Monitor update starvation** (`services/revenue/monitoringService.js`,
  found by the local PostgreSQL load test): many concurrent API submissions
  to ONE monitor could exhaust the 25-attempt optimistic update loop →
  409 MONITOR_CONFLICT with the observation stored but never applied (a
  retry with the same key only replayed it). Applying is now serialized per
  monitor inside a process; the version check still guards other instances
  (P25-2 + mutation).
* **QA scoring of executions in `verifying`** (`qaService.js`): only terminal
  statuses are scored now.
