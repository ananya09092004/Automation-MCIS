# Layer 7 — Usage metering, plans, entitlements, subscriptions

Layer 7 makes Nexus revenue-ready around the existing
workspace → agent/workflow → execution architecture, without replacing any
engine. It adds an authoritative usage ledger, a central plan catalogue, ONE
entitlement service that every quota goes through, provider-neutral
subscription state with verified webhooks, a billing/usage API and a
`/billing` page. No payment provider is integrated and nothing fakes a payment.

## 1. Files

| File | Role |
|---|---|
| `migrations/20260929_layer7_billing.{up,down}.sql` | tables, RPCs, RLS |
| `services/billing/plans.js` | limit semantics, capabilities, effective-plan rules (pure) |
| `services/billing/entitlementService.js` | `checkEntitlement`, usage meter (begin/commit/release/record), billing audit |
| `services/billing/billingStore.js` | Supabase persistence |
| `services/billing/subscriptionService.js` | subscription state, webhook processing, operator assignment, checkout/cancel requests |
| `services/billing/providers.js` | provider adapters (`none`, `generic` signed webhooks) |
| `services/billing/billingService.js` | summary, plans, usage history, dashboard |
| `routes/billing.js` | `/api/workspaces/:ws/billing/*`, `/api/billing/webhooks/:provider`, production wiring, `BILLING_ENABLED` |
| `scripts/billing-set-plan.js` | operator tool: assign a plan (e.g. invoice customers) |
| hooks | Layer 1 `workspaceService` (members), Layer 3 `executionService` (executions, steps, connector calls, outcomes), Layer 4 `workflowService` (runs, active workflows), Layer 6 `routes/automation.js` (API calls, execution submission) |
| frontend | `src/billing/{BillingPage.jsx,billingApi.js,BillingPage.test.js}`, `/billing` route, sidebar link |

## 2. Database

- `billing_plans` — id, name, description, `limits` jsonb, `price` jsonb (display only; seeded `null` = not configured), `is_public`, `sort_order`. Seeded: free, pro, business, enterprise (insert-only; an operator may edit limits in the table).
- `workspace_subscriptions` — one row per workspace (no row = Free): plan, `status` (trialing | active | past_due | cancelled | expired), `provider`, external customer/subscription ids (unique per provider), current period, trial end, cancel-at-period-end, `last_provider_event_at`, version (CAS).
- `usage_events` — the authoritative, **immutable** ledger (trigger blocks UPDATE/DELETE; workspace deletion still cascades). `unique (workspace_id, idempotency_key)`; `quantity between 1 and 1000000`; metric check list; indexes on (workspace, metric, time) and (workspace, time).
- `usage_reservations` — quota reservations (reserved → committed | released; TTL).
- `billing_webhook_events` — `unique (provider, event_id)` replay ledger with status and payload hash.
- RPCs (service_role only): `billing_reserve_usage` (advisory-locked check-and-reserve), `billing_record_usage`, `billing_release_reservation`, `billing_usage_totals`, `billing_usage_daily`.
- RLS enabled on all five tables with no policies; `anon` / `authenticated` have no table or function privileges.

## 3. Usage model

| Metric | Recorded when | Idempotency key |
|---|---|---|
| `agent_execution` | a Layer 3 execution is created (quota: executions) | `exec:<Idempotency-Key or id>`; workflow steps `exec:wf:<run>:<position>` |
| `workflow_run` | a run is created (manual, API, schedule) (quota: workflow runs) | `wfrun:key:<key>`, `wfrun:slot:<workflow>:<slot>`, else `wfrun:<run>` |
| `execution_step` | an evidence step whose action was actually sent | `step:<execution>:<index>` |
| `connector_call` | a connector step that was sent (quantity = attempts) | `conn:<execution>:<index>` |
| `api_call` | every authenticated `/api/automation/v1` request | `api:<key id>:<uuid>` |
| `execution_completed/failed/cancelled` | an execution finishes | `exec_outcome:<execution>` |

Accounting semantics:
- An operation is charged once it has **started** (the execution / run row
  exists), whatever its outcome — failed and cancelled executions count.
- Refused operations are free: quota denials, firewall denials
  (`POLICY_DENIED`, `STALE_APPROVAL`, `QUOTA_EXCEEDED` steps), approvals never
  given, rejected API keys.
- Retries are not double-charged: a retried workflow step reuses its key
  (one execution charge per step), a replayed request (same Idempotency-Key)
  returns the existing row before any charge, and concurrent duplicates
  collapse onto one reservation/event.
- If the database write fails after an operation started, the operation
  is not undone; the error is logged and the reservation expires.

Daily and monthly totals are derived from the ledger (`billing_usage_daily`,
`billing_usage_totals`). Clients never submit usage.

## 4. Plans and entitlements

Limits (per plan, in `billing_plans.limits`): `executions_per_month`,
`workflow_runs_per_month`, `api_calls_per_month`, `connector_calls_per_month`,
`max_members`, `max_active_workflows`, `max_concurrent_executions`,
`usage_retention_days`. A number is a cap, `null` is unlimited, anything else
(missing, negative, string) is treated as 0 — fail closed.

`checkEntitlement(workspaceId, capability, quantity, { reserve, key })` is the
only quota decision point. Capabilities: executions, workflow_runs, api_calls,
connector_calls (metered from the ledger), members, active_workflows,
concurrent_executions (counted from source tables server-side).

Where it is enforced (when `BILLING_ENABLED=true`):
- executions — reserved atomically in `createExecution` before the row exists
- workflow runs — reserved atomically in `createRunRecord`
- API calls — reserved per authenticated automation request
- connector calls — checked before each connector call (executions in a workspace are serialized by Layer 3, so this cannot race)
- members — at invitation (pending invitations reserve a seat) and at acceptance
- active workflows — when publishing / re-activating makes a workflow active
- concurrent executions — Layer 3 already allows one active execution per workspace; the limit is reported, not separately enforced

Order for a limited operation: authenticate (Firebase / API key) → resolve and
authorize the workspace (Layer 1) → Layer 3/4 validation → **entitlement
reservation** → execute (each step still goes through the Layer 6 firewall and
approvals) → commit the usage event. Roles never bypass limits; limits never
grant permissions.

Effective plan from the subscription: none → free; trialing → plan until
`trial_ends_at`; active → plan until `current_period_end` + 3 days; past_due →
plan until `current_period_end` + `BILLING_PAST_DUE_GRACE_DAYS` (7);
cancelled → plan until `current_period_end`; expired → free. The usage period
is the subscription period when inside it, else the calendar month (UTC).

Errors: `402 QUOTA_EXCEEDED` (limit reached), `503 ENTITLEMENT_UNAVAILABLE`
(could not verify — fail closed). Denials are audited as `billing.quota_exceeded`.

## 5. Subscriptions and providers

Subscription status changes only through a verified provider webhook or the
operator script (`provider = 'manual'`). The app's checkout / cancel endpoints
forward to the active provider adapter; with none configured they return
`501 PAYMENTS_UNAVAILABLE` and the UI labels upgrades as unavailable.

Adapter interface (`services/billing/providers.js`): `verifyWebhook(rawBody,
headers, now)`, `normalize(event)`, optional `createCheckout` / `createPortal`.
Shipped: `none`, and `generic` — provider-neutral subscription events signed
with HMAC-SHA256 over `"<unix seconds>.<raw body>"` (header
`Nexus-Signature: t=…,v1=…`, 5-minute tolerance). A Stripe adapter would plug
into the same interface; none is included.

Webhook endpoint `POST /api/billing/webhooks/:provider` (raw body, no user
auth): signature + timestamp → `(provider, event_id)` ledger (duplicate →
acknowledged, not re-applied) → workspace must exist → plan must exist →
binding (a subscription id bound to workspace A never moves to B; a workspace
bound to customer X is not re-bound to Y; a workspace managed by another
active provider is not taken over) → ordering (older events ignored) → CAS
update → audit.

## 6. API

`/api/workspaces/:ws/billing` (Firebase + membership): `GET /` (plan,
subscription status, period, meters), `GET /plans`, `GET /usage?days=` (bounded
by retention), `GET /dashboard?days=`; `POST /subscription/checkout` and
`/subscription/cancel` (owner/admin). External customer/subscription ids and
secrets are never returned.

API keys: the Layer 6 implementation only (create / list / revoke / rotate
under `/security/api-keys`; plaintext shown once). New scope
`executions:run`. `/api/automation/v1` adds `POST /executions` (goal +
Idempotency-Key) and `GET /executions/:id`; key-submitted work runs through
Layer 3 with member rights, the Agent Firewall and approvals.

## 7. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `BILLING_ENABLED` | `false` | `true` enforces plan limits (fail closed). Otherwise usage is metered only and the UI says limits are not enforced. |
| `BILLING_PROVIDER` | `none` | `generic` enables the signed-webhook adapter |
| `BILLING_WEBHOOK_SECRET` | – | ≥ 32 characters, required for `generic` |
| `BILLING_PAST_DUE_GRACE_DAYS` | 7 | grace after a failed renewal |

Deployment: apply `20260929_layer7_billing.up.sql` → deploy code → (optional)
assign plans with `node scripts/billing-set-plan.js --workspace … --plan … --operator …`
→ set `BILLING_ENABLED=true` when ready. Rollback: code first, then the down
migration (the ledger, subscriptions and plan catalogue are dropped; Layers 1–6 untouched).

## 8. Known limitations

- No payment provider is integrated; paid plans are assigned by webhook from
  an external billing system or by the operator script. Prices are not
  configured (`price = null`, shown as "contact the Nexus team").
- Connector-call and count-based limits are checked (not reserved); they are
  race-free per workspace because Layer 3 runs one execution per workspace
  at a time, and invitations / publishing are low-frequency admin actions.
- Usage retention only bounds what the API returns; old ledger rows are not deleted.
- `max_concurrent_executions` is informational above 1 (Layer 3 runs one execution per workspace).

## Layer 8 update

- Payment providers: `stripe` joins `none` / `generic` (`services/billing/stripeProvider.js`, active with `STRIPE_ENABLED=true` and complete configuration). Stripe webhooks never trust a workspace id from the event body: the workspace is resolved through `billing_customers` / `billing_checkout_sessions` (Layer 8 migration).
- `POST /subscription/portal` (owner/admin) opens the provider's billing portal; `POST /subscription/cancel` cancels a Stripe subscription at period end (confirmed by webhook).
- `GET /` keeps the Layer 7 `payments` object unchanged and adds `paymentStatus` (per-caller available actions, provider status, missing setting names for owners/admins) and `customLimits`. `GET /plans` adds `features` and `purchasable`.
- Plan features (`billing_plan_features`) and Enterprise custom limits (`workspace_plan_overrides`, operator script `--limits`) are applied by the same entitlement service; `api_access` and `workflow_templates` are feature-gated when `BILLING_ENABLED=true`.
- A webhook whose processing fails for a non-verdict reason (e.g. the provider API is unreachable) is removed from the ledger, so the provider's retry is processed instead of being treated as a duplicate.

## Layer 9 update

Status of the limitations above after Layer 9 (details: `LAYER9_LIMITATION_LEDGER.md`):

- **L7-1 — CLOSED**: No payment provider → Obsolete: Layer 8 Stripe adapter.
- **L7-2 — CLOSED**: Count-based limits checked, not reserved (members, active workflows) → members and active_workflows: post-write verification under a per-workspace row lock (RPCs enforce_member_limit / enforce_active_workflow_limit); an over-limit writer undoes its own write. Exactly the free capacity is granted under concurrency (memory + Postgres).
- **L7-3 — CLOSED**: Connector-call limits checked not reserved → Obsolete: one active execution per workspace is a DB unique index; connector calls are reserved per execution.
- **L7-4 — CLOSED**: Usage retention only bounds the API; ledger rows never deleted → Real retention: RPC retention_purge_workspace (usage ledger, reservations, finished runs/executions + cascades, audit) with DB-enforced floors; owner settings, "Apply now", periodic sweep on workers; audited with counts; tested on Postgres.
- **L7-5 — CLOSED**: max_concurrent_executions informational → max_concurrent_executions enforced in createExecution (0 → 402 before anything starts).
