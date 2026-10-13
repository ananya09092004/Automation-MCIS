# Layer 8 — customer-ready SaaS: onboarding, templates, team, real billing

Layer 8 turns the Layer 1–7 platform into a product a customer can sign up
for and use end to end:

onboarding → workspace → team → template workflow → run (entitlement →
firewall → approval → execution → evidence → verification) → usage → billing

Nothing in Layers 1–7 is replaced. Every Layer 8 feature calls the existing
services with the signed-in user's own context, so workspace isolation,
roles, plan limits, the Agent Firewall, approvals, evidence and audit apply
unchanged. The voice system is untouched.

## 1. Files

| File | Role |
|---|---|
| `migrations/20260930_layer8_customer.{up,down}.sql` | onboarding state, provider bindings, checkout sessions, plan features, Enterprise overrides |
| `services/billing/stripeProvider.js` | Stripe adapter (fetch-based, no SDK): customers, Checkout, Customer Portal, subscriptions, signed webhooks |
| `services/billing/providers.js` | provider registry: `none`, `generic` (Layer 7), `stripe` |
| `services/billing/subscriptionService.js` | + customer-bound webhooks, checkout / portal / cancel, Enterprise custom limits |
| `services/billing/entitlementService.js` | + plan features, feature gates, Enterprise overrides (same single decision point) |
| `services/billing/billingService.js` | + `paymentStatus` (what the provider can really do for this caller), plan `features` / `purchasable` |
| `services/templates/{catalog,templateService}.js` | 8 built-in templates = Layer 4 definitions + metadata |
| `services/onboarding/{onboardingService,onboardingStore}.js` | resumable, idempotent onboarding |
| `services/customer/overviewService.js` | workspace overview + customer-safe observability |
| `services/automation/apiSpec.js` | OpenAPI description of the API-key surface |
| `services/config/productionConfig.js`, `scripts/check-config.js` | production configuration checker |
| `routes/customer.js` | `/api/onboarding`, `/api/workspaces/:ws/templates`, `/api/workspaces/:ws/overview` |
| `routes/billing.js` | + `POST /subscription/portal` |
| `routes/automation.js` | + public `GET /openapi.json`; plan feature `api_access` |
| `docs/PRODUCTION_CONFIG.md` | required / conditional / optional / development-only settings |
| frontend | `/onboarding`, `/workspace`, `/developers`, `/welcome`; `/billing` actions |

## 2. Database (Layer 8 migration only)

- `user_onboarding` — one row per user: step, personal / company workspace, invites, use case, template, first workflow / run, completed, version (CAS). References are `on delete set null`.
- `billing_customers` — `(workspace_id, provider)` primary key, `unique (provider, external_customer_id)`: a workspace has one customer per provider and a customer belongs to one workspace.
- `billing_checkout_sessions` — sessions this server created (workspace, plan, customer, requester, status open → completed | expired, CAS on status). `unique (provider, external_session_id)`.
- `billing_plan_features` — per-plan capability flags (missing = included; explicit `false` = excluded).
- `workspace_plan_overrides` — operator-set Enterprise limits (same semantics as plan limits).
- RLS on all five, no policies; `anon` / `authenticated` have no privileges; service role only. No Layer 1–7 table, column, row, function or policy is changed.

## 3. Billing provider abstraction + Stripe

Interface: `configured`, `missing[]` (setting names), `priceForPlan`, `createCustomer`, `createCheckout`, `createPortal`, `retrieveSubscription`, `cancelSubscription`, `verifyWebhook`, `normalize`.

Stripe is active only with `STRIPE_ENABLED=true` **and** a valid secret key, webhook secret, at least one `STRIPE_PRICE_<PLAN>` and `APP_BASE_URL`. Otherwise every payment action returns `501 PAYMENTS_UNAVAILABLE` ("Payments are not configured for this deployment.") and the UI disables Upgrade / Manage / Cancel.

- **Checkout** (owner/admin, never an API key): plan must be purchasable (a server-side price exists; Enterprise never is); a workspace with an active online subscription is sent to the portal instead (no double subscriptions); one Stripe customer per workspace (Stripe idempotency key + unique binding); the price, workspace and return URLs come from the server, never the client; the session is recorded. The returned URL is Stripe-hosted. A return to `/billing?checkout=success` claims nothing.
- **Webhooks** (`POST /api/billing/webhooks/stripe`, raw body): `Stripe-Signature` HMAC-SHA256 (any `v1`), 5-minute tolerance → `(provider, event_id)` ledger (duplicates acknowledged, never re-applied) → workspace resolved **only** through `billing_customers` / `billing_checkout_sessions` (metadata and `client_reference_id` in the body are ignored) → for subscription events the current subscription is re-read from Stripe (order-independent) → plan from the price id (unknown price → rejected) → `incomplete` subscriptions change nothing → Layer 7 binding rules (a subscription never moves between workspaces; a manually managed Enterprise workspace is not taken over) → CAS write → audit. A processing error removes the ledger row so Stripe's retry is processed.
- **Cancel** requests `cancel_at_period_end` at Stripe; the local state changes only when Stripe confirms by webhook. **Manage** opens the Stripe Customer Portal.
- `checkout.session.completed` marks the session completed but changes no plan: the plan changes when the subscription itself is reported active.

## 4. Plans

Provider-neutral: limits in `billing_plans.limits`, display price in `billing_plans.price` (`{amount, currency, interval}` or `{display}`), capabilities in `billing_plan_features`, Stripe prices in `STRIPE_PRICE_<PLAN>`. Free needs no payment. Enterprise: custom price (contact), custom limits (`scripts/billing-set-plan.js --plan enterprise --limits '{…}'`), manual activation; custom limits apply only while the subscription is in force.

Feature gates enforced through the entitlement service when `BILLING_ENABLED=true`: `api_access` (automation API, checked in the same plan read as the API-call quota), `workflow_templates` (template instantiation). 402 `FEATURE_NOT_IN_PLAN`.

## 5. Onboarding (`/api/onboarding`, `/onboarding`)

`start` → `workspace` (create company / pick an existing membership / stay personal) → `team` (invites or skip) → `use-case` → `template` (created and published by the user through Layer 4) → `first-run` (Layer 4 run with a deterministic idempotency key) → done. `complete` skips at any time.
Resumable (server state), idempotent (repeats return the same workspace / workflow / run; concurrent creates are resolved by CAS and the loser's duplicate is deleted), no privilege escalation (all actions via Layer 1/4 with the user's context: non-members 404, invitation role rules, plan member limits; "owner" is never granted by an invite). Existing users are never forced into it: `required` is true only for a brand-new user with just a personal workspace and no workflows. `ONBOARDING_ENABLED=false` turns it off.

## 6. Templates (`/api/workspaces/:ws/templates`)

Research & comparison, Website / company research, Document extraction, Spreadsheet analysis, Competitor monitoring (needs an HTTP API integration), Data validation, Report generation (approval before the final step), GitHub issue digest (needs GitHub). Each defines name, description, category, inputs, expected output, risk level, required integrations and steps. Instantiation creates an ordinary Layer 4 draft (optionally published under Layer 4's publish rules). The client can choose only the template, a name and which of **its** workspace's integrations to use — never steps, approvals or policies. Required integrations are reported as connected / not connected per workspace. `TEMPLATES_ENABLED=false` turns them off.

## 7. Workspace experience + collaboration (`/workspace`)

Overview (usage, success rate, latency, approvals waiting, tasks, connector health; owners/admins also see quota / billing / security failures), Team (members, roles, invitations, join with a code), Tasks (assign to a teammate or the AI agent, status), Activity & approvals (recent executions with approve / reject, recent runs), Templates, plus links to the existing Workflows, Integrations, Billing, Security and API pages. The UI hides controls the server would refuse; the server enforces every rule.

## 8. Observability (`GET /api/workspaces/:ws/overview`)

Built only from existing records in a fixed set of parallel, bounded queries: Layer 7 usage ledger (counts, success/failure rate), last 50 executions (latency p50/p95, approval waits), last 50 runs (workflow success rate), integrations (connector health), tasks, and — owners/admins only — the audit log (quota denials, billing failures) and security events. Never credentials, secrets, raw inputs or audit payloads.

## 9. API documentation (`/developers`, `GET /api/automation/v1/openapi.json`)

Public OpenAPI 3.0 description generated by `services/automation/apiSpec.js`: authentication, scopes, every endpoint with request / response schema, idempotency, quotas, rate limits, approvals and error codes, plus copyable examples with placeholders. A test checks the documented routes equal the router's routes.

## 10. Configuration

See `docs/PRODUCTION_CONFIG.md` and `node scripts/check-config.js`.
New settings: `STRIPE_ENABLED` (default false), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_<PLAN>`, `STRIPE_API_VERSION` (optional), `APP_BASE_URL`, `PUBLIC_API_URL`, `ONBOARDING_ENABLED` (default true), `TEMPLATES_ENABLED` (default true).

Deployment: apply `20260930_layer8_customer.up.sql` → deploy backend + frontend → run `check-config` → (optional) configure Stripe (see the checklist) → set `STRIPE_ENABLED=true`. Rollback: code first, then the down migration (Layers 1–7 data untouched).

## 11. Known limitations

- Stripe is implemented and tested against a deterministic local double of Stripe's API; it has not been exercised against Stripe itself because no Stripe account / keys exist for this project. Do a test-mode end-to-end run (checkout with a test card, portal, cancel, webhook delivery) before taking live payments.
- Plan changes for existing Stripe subscribers go through the Stripe Customer Portal (the portal's allowed products must be configured in Stripe).
- Display prices are operator-set in `billing_plans.price`; they are not read from Stripe.
- Invitations are not emailed: the one-time invite code is shown to the inviter to share (Layer 1 behaviour).
- The overview's latency / success figures for runs use the most recent 50 records; the 30-day counts come from the usage ledger.
- Onboarding's "first safe task" still needs the desktop execution bridge (Nexus) to perform browser/desktop actions.

## Layer 9 update

Status of the limitations above after Layer 9 (details: `LAYER9_LIMITATION_LEDGER.md`):

- **L8-1 — EXTERNAL VALIDATION**: Stripe not exercised against Stripe test mode → Stripe tested against a deterministic Stripe API double only (no Stripe account/keys supplied). External step: the test-mode checklist in PRODUCTION_RUNBOOK.md §6 with sk_test keys and a webhook endpoint.
- **L8-2 — EXTERNAL VALIDATION**: Plan changes via Stripe Customer Portal configuration → Plan changes for existing subscribers use the Stripe Customer Portal; its products must be configured in the Stripe dashboard.
- **L8-3 — INTENTIONALLY UNSUPPORTED**: Display prices operator-set, not read from Stripe → Display prices are operator-set (no provider call per page view).
- **L8-4 — REMAINING**: Invitations not emailed → Same as L1-4 (email provider).
- **L8-5 — INTENTIONALLY UNSUPPORTED**: Overview latency/success uses the last 50 records → Bounded overview queries by design; 30-day totals come from the ledger.
- **L8-6 — EXTERNAL VALIDATION**: First safe task needs the desktop bridge → Desktop/browser actions need a running Nexus desktop agent on the customer machine.
