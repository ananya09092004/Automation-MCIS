# Billing / entitlement status

This document used to say **"there is no real billing system in this
codebase"**. That was true when it was written, but it is no longer true
and had gone stale: a real workspace billing/entitlement system (Layer 7,
with a real Stripe adapter added in Layer 8) now exists, is wired into the
workflow/connector/API execution paths, and is covered by automated tests
(`__tests__/billing.test.js`, `__tests__/customer.test.js`,
`__tests__/revenue.test.js`, `__tests__/hardening.test.js`). Leaving the old
claim in place would have been exactly the kind of false statement a
pre-launch audit exists to catch — in the opposite direction from the usual
risk (this one *under*-claimed what the product does), but still wrong.
This file now describes what is actually there, split into the two
separate "tier" concepts this codebase has, because they are easy to
confuse with each other.

## Two separate things named "tier" / "billing"

1. **Workspace billing & entitlements (Layer 7/8) — real, in production use.**
   Plans, usage metering, quota enforcement, subscription state, and a real
   Stripe adapter (Checkout + Customer Portal + verified webhooks). This is
   what gates workspace executions, workflow runs, connector/API calls, and
   team size. Fully described in `docs/LAYER7_BILLING.md` — read that file
   for the real detail (tables, RPCs, usage model, provider adapters,
   routes). In short:
   - `services/billing/entitlementService.js` is the one place every quota
     check goes through (`checkEntitlement`), backed by an immutable
     `usage_events` ledger and race-free reservations.
   - `services/billing/providers.js` ships three adapters: `none` (nothing
     configured — payment actions report 501, never a fake success),
     `generic` (HMAC-signed webhooks from an external/invoicing system,
     read-only — no checkout), and `stripe`
     (`services/billing/stripeProvider.js` — real Checkout, Customer
     Portal, and signature-verified webhooks). Which one is active is
     config-driven (`STRIPE_ENABLED` + the full `STRIPE_*` set); nothing
     here invents a payment provider or fakes a successful charge.
   - `routes/billing.js` exposes this at
     `/api/workspaces/:workspaceId/billing/*` plus the webhook endpoint,
     and the frontend has a real `/billing` page
     (`src/billing/BillingPage.jsx`) built on it.
   - This is the system a customer is actually billed through, and the one
     that determines what a workspace's plan allows.

2. **Legacy per-account daily chat-message cap
   (`mcis/backend/middleware/dailyLimit.js`) — still free-only, by design.**
   This predates Layer 7 and is unrelated to it: a simple message-count
   limit on the personal chat surface, keyed by a `tier` of `'free'` or
   `'pro'`. `resolveServerSideTier()` here still unconditionally returns
   `'free'` for everyone — **this part of the original claim is still
   accurate** — because nothing has wired this specific, older check up to
   the real Layer 7 subscription state yet. It is not a fake entitlement
   check: it never trusts a client-supplied tier (a client cannot forge
   `pro` by sending `tier: "pro"` in the request body), it just has one
   honest answer (`'free'`) until it's pointed at the real subscription
   record.

   If/when this personal daily-message cap should instead reflect a
   workspace's real Layer 7 plan, the fix is narrow and localized: change
   `resolveServerSideTier()` to look up the caller's current workspace
   subscription (`services/billing/subscriptionService.js` /
   `billingStore.js`) instead of returning a literal `'free'`, the same
   way every other Layer 7-gated feature already does. Nothing else in
   `dailyLimit.js` needs to change — `checkDailyLimit()` already treats
   this function's return value as authoritative and never reads a tier
   from the request itself.

## What this means for the product today

- Workspace-level plans, usage limits, and payment are real, tested, and
  fail closed (no provider configured → 501 and no silent "it worked";
  client-supplied usage/plan/workspace values are always ignored in favor
  of server-side state — see `docs/LAYER7_BILLING.md` §"client spoofing").
- The separate, older personal daily-chat-message cap genuinely has no paid
  tier behind it yet and is not claiming to.
- `DAILY_MESSAGE_LIMIT_PRO` and the `pro` entry in `dailyLimit.js`'s
  `TIER_LIMITS` are left in place (unused today) so a future
  `resolveServerSideTier()` change has a limit value ready to use, rather
  than needing to reintroduce the same number later.
