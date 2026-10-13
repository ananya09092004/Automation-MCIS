# API

This describes the **automation API** — the key-authenticated API meant
for a customer's own code to call. It is not the API the web frontend
itself uses (that's a normal authenticated browser session against
`/api/*` with a Firebase ID token, and isn't meant to be called directly by
third-party code).

## Live, self-describing reference

```
GET /api/automation/v1/openapi.json
```

No API key required. This is the authoritative route/scope list — read
it from your own deployment rather than trusting a hand-copied list here
going stale. It's generated from the real route table
(`mcis/backend/services/automation/apiSpec.js`), so it can't drift from
what's actually mounted.

## Authentication

```
Authorization: Bearer nxk_<your workspace API key>
```
or
```
X-Api-Key: nxk_<your workspace API key>
```

A key in the URL (`?api_key=`, `?key=`, `?token=`) is refused on purpose —
URLs end up in logs, browser history and referrer headers, and a key
should never land there.

A key resolves to exactly one workspace, with **member**-level rights —
never more, regardless of who created the key. Create and manage keys from
your workspace's settings in the app (Layer 6).

## What you can do with it

| Method & path | Scope | What it does |
|---|---|---|
| `POST /workflows/:workflowId/runs` | `workflows:run` | Start a run of a published workflow (`{ inputs? }`, `Idempotency-Key` header). |
| `GET /runs/:runId` | `runs:read` | Run status, steps, evidence summary. |
| `GET /runs?workflowId=&status=&limit=&cursor=` | `runs:read` | Page through runs (cursor-based, no gaps or duplicates). |
| `POST /executions` | `executions:run` | Start an ad-hoc agent execution (`{ goal }`, `Idempotency-Key` header). |
| `GET /executions/:executionId` | `runs:read` | Execution status, progress, approval state. |
| `GET /executions?status=&limit=&cursor=` | `runs:read` | Page through executions. |
| `GET /executions/:id/evidence`, `GET /runs/:id/evidence` | `runs:read` | Evidence recorded for that run/execution. |
| `POST /qa/projects/:id/runs`, `POST /qa/runs/:id/results/:resultId` | `qa:run` | Start / record results for a QA run. |
| `GET /qa/runs/:id`, `GET /qa/projects/:id/metrics` | `qa:read` | QA run status and project metrics. |
| `GET /monitoring/monitors[/:id]`, `/monitoring/changes`, `/monitoring/alerts`, `/competitors/dashboard` | `monitoring:read` | Revenue/monitoring suite reads. |
| `POST /monitoring/monitors/:id/observations` | `monitoring:write` | Submit an external observation. |
| `GET /usage` | `usage:read` | This workspace's usage/quota state. |

Every authenticated call counts as one `api_call` against your plan's
`api_calls_per_month` quota (reserved atomically; `402 QUOTA_EXCEEDED` when
exhausted — see `mcis/backend/docs/LAYER7_BILLING.md`). Starting a run or
execution additionally consumes that feature's own quota.

## Guarantees worth knowing before you build on this

- **Idempotency**: `POST /workflows/:workflowId/runs` and `POST
  /executions` require an `Idempotency-Key` header; a retried request with
  the same key never starts a second run.
- **Approvals are never bypassable from the API**: a workflow step
  requiring human approval still waits for one — an API key can start a
  run, but cannot itself approve a sensitive step.
- **The Agent Firewall still applies**: a run started via the API goes
  through the same workspace security policy as one started from the app.
  If the policy denies an action, the API call doesn't change that.
- **Pagination is real cursor pagination** — opaque cursors, no
  "page number drifts under concurrent writes" problem.
- **Rate limiting**: failed authentication attempts are limited per
  client IP; successful-key request volume is limited per key, shared
  across all backend instances (not just the one that happened to handle
  your request).

## Webhooks (billing)

A separate, unauthenticated-by-Firebase-definition endpoint exists for
payment-provider webhooks:

```
POST /api/billing/webhooks/:provider
```

This is authenticated by the provider's own request signature (verified
server-side), not by a user or API key — it's how Stripe (or a configured
generic signed-webhook provider) tells this backend about a subscription
change. You will not call this yourself unless you are the payment
provider's webhook delivery system. See `mcis/backend/docs/LAYER7_BILLING.md`.
