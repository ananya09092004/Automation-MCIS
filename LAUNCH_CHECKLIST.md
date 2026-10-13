# Launch checklist

This is the running record of this pre-launch security-hardening pass:
every finding that was prioritized, what was actually done about it, and
how to verify it yourself. For the full audit narrative and the final
launch recommendation, see the "NEXUS FINAL LAUNCH READINESS REPORT"
delivered at the end of this pass. This file is the checklist form of
that report — shorter, and meant to stay useful as an ongoing pre-launch
gate for future changes, not just a one-time record.

Status legend: **DONE** (fixed and verified), **VERIFIED EXISTING** (found
to already be correctly implemented — no change needed), **OPEN** (known
gap, not fixed in this pass — see `LIMITATIONS.md`).

## Blockers (fixed first, per the governing priority order)

| # | Finding | Status | Evidence |
|---|---|---|---|
| B1 | Approval tokens for high-risk Nexus actions weren't cryptographically bound to the action | DONE | `nexus/common/approval.py` HMAC-SHA256 binding; `nexus/tests/test_authorization_boundary.py`, `test_execution_contracts.py`, `test_safety_acceptance_unit.py` |
| B2 | Playwright navigation/SSRF protection didn't re-check redirect hops | DONE | `nexus/browser/security/` navigation guard; browser SSRF tests |

## High priority

| # | Finding | Status | Evidence |
|---|---|---|---|
| C1 | Emergency stop was global instead of scoped to the calling principal | DONE | `backend-routing/taskPlanner.js` principal-scoped stop, decoupled from `executionService.js`'s workspace-scoped stop; 5 new tests in `security_hardening.test.js` |
| C2 | `PERMISSIONS_ENFORCED` could be left unset in production with no fail-closed gate | DONE | `config/validateConfig.js` / `services/config/productionConfig.js` fatal-on-unset/invalid; `scripts/check-config.js` |
| C3 | No user-facing data export/delete UI, and the backing route's IDOR protection was untested | DONE | `routes/dataControls.js` (pre-existing, now tested), `SettingsPanel.js`'s `DataControlsPanel` (new), `P-SEC-5` tests, `SettingsPanel.test.js` |
| C4 | `.env.example` was stale/incomplete against real runtime config | DONE | Full rewrite reconciled against `validateConfig.js`/`productionConfig.js`; fixed `PORT` 5000→5051 mismatch and a false "no billing exists" comment |
| C5 | No graceful shutdown — `SIGTERM`/`SIGINT` had no handler at all | DONE | `config/gracefulShutdown.js` (new), wired into `server.js`, 7 unit tests + a real process-level smoke test |

## Medium priority / customer experience

| # | Finding | Status | Evidence |
|---|---|---|---|
| D1 | `start_process`/`restart_process` ran with no approval-gating or risk classification on either the Nexus or Node side | DONE | Added to `HIGH_RISK_ACTIONS` (`nexus/common/approval.py`) and `RED_ACTIONS` (`backend-routing/riskModel.js`); 8 new adversarial tests (`nexus/tests/test_process_start_security.py`) |
| D2 | "Explicit data-control ownership, not a global regex allowlist as the only protection" | DONE | Found a real gap: `GET /:userId/report/weekly` in `routes/goals.js` was missing from `middleware/auth.js`'s pattern list (cross-user IDOR). Fixed the regex AND, more durably, added an explicit inline ownership check to every `:userId` handler in `goals.js` so this class of gap can't silently recur there. New regression test in `__tests__/workspaceDataScoping.test.js` ("P-SEC-7") |
| D3 | Real landing page at `/` for logged-out users | DONE (public-launch pass; see P4 below) — this entry originally accepted `/` showing `Auth.js`'s own product copy as sufficient; the public-launch pass found that wasn't the same thing as the real landing experience and fixed it |
| D4 | Improved onboarding flow | VERIFIED EXISTING | `src/onboarding/OnboardingPage.jsx` at `/onboarding`, backed by the tested Layer 8 onboarding service |
| D5 | Product labels distinguishing native/connector/customer-URL/demo-fixture/external-setup-required/unsupported execution | PARTIAL — removed a real honesty risk (dead fake-execution code in `services/adversarialTestService.js`, never wired to a route, now deleted); the unified labeling taxonomy itself is still **OPEN** — see `LIMITATIONS.md` |
| D6 | Stripe adapter tests | VERIFIED EXISTING | `__tests__/customer.test.js` exercises `createStripeProvider` directly (webhook signature verification, configured/unconfigured states) |
| D7 | Doc stubs — populate or remove misleading empty docs | DONE | `docs/BILLING.md` was the one stale/false doc found (claimed "no billing system exists" after Layer 7/8 billing was built) — rewritten accurately; every other doc checked was already substantial, not a stub |
| D8 | CORS / config: explicit, fail closed if required | VERIFIED EXISTING (+ cleanup) | `server.js`'s CORS origin check already fails closed; `ALLOWED_ORIGINS` already validated in production by `productionConfig.js`; removed a stray debug `console.log` |
| D9 | Voice-device principal hardening (document, don't redesign) | DONE | Documented in `SECURITY.md`'s "Identity and authorization" section; code itself (`security-engine/callerIdentity.js`) already carried accurate inline documentation, not changed |

## Public-launch hardening pass (second pass, after the above)

| # | Finding | Status | Evidence |
|---|---|---|---|
| P1 | D5's execution-labeling taxonomy, left OPEN above, now actually built | DONE | New `services/templates/executionSource.js` (8-value taxonomy); every step of all 17 built-in templates tagged; `services/templates/templateService.js`'s `view()` computes each step's real source live against per-workspace integration state (never static); surfaced in the Templates tab UI (`WorkspacePage.jsx`); 6 new unit tests + ~10 new integration assertions + 1 new frontend test, all passing |
| P2 | Voice-device shared secret: no way to revoke one compromised device without rotating the secret for everyone | DONE | Additive `NEXUS_VOICE_DEVICE_REVOKED_IDS` denylist in both independent resolvers (`backend-routing/resolveUserId.js`, `security-engine/callerIdentity.js`); checked only after the shared secret itself validates (never leaks revocation status to a wrong-secret caller); existing `deviceId`-as-label / `isSamePrincipal` design deliberately left unchanged (redesigning it was explicitly out of scope and would have broken passing tests); 11 new regression tests (`__tests__/voiceDeviceRevocation.security.test.js`) covering valid/revoked/rotated-token/cross-device/cross-workspace scenarios; zero regressions in the existing 27-test voice security suite |
| P3 | Billing/entitlement consistency: is there one authoritative server-side model, and does the legacy chat quota contradict it? | VERIFIED EXISTING — no change needed | Full repo audit (every file referencing `quota`/`tier`/`entitlement`/`plan`) confirms exactly one real entitlement path (`services/billing/entitlementService.js`, workspace-scoped, fail-closed, never trusts a client-supplied plan/tier/quota/workspace value — see `__tests__/billing.test.js`'s "Q client spoofing" test, already passing); the legacy per-user chat cap (`middleware/dailyLimit.js`) operates on a capability (`chat_messages`) that doesn't exist in the Layer 7 model at all, so it cannot contradict it — it is hardcoded to `'free'`, never reads a client-supplied tier, and is already accurately documented as a separate, not-yet-wired-to-real-billing system in `docs/BILLING.md`; the one manual plan-override path (`assignPlanManually`/`setPlanOverride`) is reachable only from an internal CLI script (`scripts/billing-set-plan.js`), never an HTTP route; Stripe webhook signature verification is real HMAC-SHA256 (`services/billing/stripeProvider.js`), never fabricated — live Stripe test-mode validation itself is **EXTERNAL VALIDATION REQUIRED** (this sandbox has no network egress to Stripe and no real test keys) |
| P4 | Root route: `/` vs `/welcome` for logged-out vs. authenticated users | DONE | New `src/RootRoute.jsx`, wired at `/` in `index.js`: resolves Firebase auth state once (loading shell until then, never guesses), then renders the real `LandingPage` for a logged-out visitor or `App` (dashboard) for an authenticated one. The actual sign-in form moved to a new `/signin` route (`<App/>` directly, unchanged behavior) so `LandingPage`'s "Sign in" links (updated from `/` to `/signin`) don't loop back to the landing page instead of the form. 3 new tests (`src/RootRoute.test.js`) + 1 new `LandingPage.test.js` assertion; full frontend suite (76/76) and `npm run build` both pass with no regressions |
| P5 | Final fresh attacker review: cross-tenant, IDOR, approval forgery/replay, action substitution, prompt injection, SSRF (+ redirect/private-IP/metadata), terminal command injection, process-start abuse, credential leakage, API-key abuse, webhook forgery, stale worker execution, workflow retry abuse, scheduled-job authorization, billing/quota forgery, voice-device abuse, data export/delete abuse | VERIFIED EXISTING — no new vulnerability found, no change needed | Every category above already has explicit, passing regression coverage from earlier phases (full inventory: `__tests__/security.test.js` Y/M — SSRF + redirect/private-IP/metadata, OAuth replay; `__tests__/hardening.test.js` P9-1 — approval binding single-use/non-transferable, API keys can never approve; `nexus/tests/test_approval_binding_security.py` — 18 tests binding an approval token to the exact action/input/target/workspace/caller/platform (action substitution); `nexus/tests/test_process_start_security.py` — process-start abuse; `__tests__/workflows.test.js` "scheduling" — admin-only, race-free one-run-per-slot, a schedule whose owner lost admin is disabled rather than run; `__tests__/billing.test.js`/`revenue.test.js`/`customer.test.js` P16-1/P16-2/P13-1 — lease+fence so two workers never double-claim, a lost lease's result never overwrites state; `integrations.test.js` R — a failed non-idempotent write is never auto-retried; `billing.test.js` Q — client-forged plan/tier/quota/workspace ignored; `voiceDeviceRevocation.security.test.js` (new this pass, Task 2 above) — voice-device abuse; `hardening.test.js`/`billing.test.js` P14-1/P14-2 — export/delete owner-only, no secrets, audited. This pass's own new code (the execution-source taxonomy and the voice-device revocation check) was itself checked for credential/secret leakage — `templateService.js`'s `view()` and `connectedIntegrations()` return only `{id, name, provider}`/step metadata, never a credential — and found clean. `nexus` (`pytest -m "not live"`, Linux): 169 passing, 6 failed + 6 collection errors — all pre-existing/environmental (Windows-only modules `pygetwindow`/`pyautogui`; 3 of the 6 failures are SSRF-allowlist tests expecting to reach `example.com`, which this sandbox's own network policy blocks outright — not a code regression; no `nexus/` file was touched this pass) |
| P6 | Final customer-trust review: no fake integrations/automation/Stripe success, no unsupported marketplace access or compliance certifications, no "100% secure"/"unhackable" language, anywhere in UI/README/docs/marketing/API docs | VERIFIED EXISTING — no change needed | Repo-wide case-insensitive scan for the exact red-flag phrases ("100% secure", "unhackable", "bank-level/military-grade security", "fully autonomous", "guaranteed", "SOC2/ISO27001/HIPAA/GDPR/PCI certified", "never fails", "unlimited automation") across every `.md`/`.jsx`/`.js` file found zero marketing overclaims — the handful of hits were all accurate, scoped engineering language ("isolation guarantees (enforced and tested)" in `docs/LAYER1_MULTI_TENANT.md`, the internal GREEN risk-tier comment in `riskModel.js`) already covered by `LandingPage.test.js`'s existing no-overclaim assertion (still passing). `DevelopersPage.jsx` (`/developers`) renders live from the server's own `GET /openapi.json`, so it structurally cannot describe an endpoint that doesn't exist. The one borderline item found — `CompetitorPage.jsx`'s "Marketplace" dropdown offers `amazon`/`flipkart` as options — was traced end to end: it is only a descriptive tag on a competitor record (`services/revenue/competitorService.js`'s `MARKETPLACES`), and the actual monitor is always either the generic `web_page` connector (structured-data scraping, already tested to honestly report `source_unavailable`/`NO_STRUCTURED_DATA` rather than fabricate a value — P3-6) or `api_submission` (data the customer's own system pushes in); there is no Amazon/Flipkart-specific API integration claimed or implemented, and no marketing copy mentions either name — not a false claim, so left unchanged. No Stripe success state is ever shown without a real configured provider (`BillingPage.jsx` reflects `ps.configured` as-is). |

## Public-launch hardening pass — critical finding during final validation

| # | Finding | Status | Evidence |
|---|---|---|---|
| P7 | `scripts/mutation-test.js` itself was only safe to Ctrl-C (SIGINT); a SIGTERM (what `kill`, a CI timeout, or an orchestrator all send by default) or an uncaught exception skipped its restore entirely and left a file **mutated on disk** — a real security/honesty check silently disabled in the working tree, with no warning. This is not hypothetical: it is exactly what happened running this script during this pass's own final production-validation step, which is how the 4 live gaps in P8 were actually found. | DONE | The script now also handles `SIGTERM` and `uncaughtException` (same restore-then-exit path as `SIGINT`), and gained a cold-start `--check`/`--restore` mode that compares every mutation's exact source text against disk independent of any in-process state, so a file left mutated by *any* kind of crash is detectable (and fixable) without having to trust that a graceful shutdown happened. Verified: a full run now completes cleanly (43 killed, 0 survived, 0 not applied) and `--check` reports a clean tree afterward. |
| P8 | Final production validation surfaced 4 checks that were **already disabled on disk** before anything in this pass touched them, found via `scripts/mutation-test.js --check` after the run above: (1) `services/revenue/monitoringService.js` — `currentIsFresh` was `!!m.current` unconditionally, so a stale or failed-check value could be presented as current; (2) `services/revenue/competitorService.js`'s `rematchProduct()` re-matched **every** competitor on a product edit, not just undecided ones, so editing a product's GTIN/brand/model/SKU/name could silently overturn a human's confirm/reject decision; (3) the same file's `onMonitorChecked()` generated recommendations from **any** verified price/stock change regardless of whether the competitor **match itself** was verified, so an unverified (possibly wrong) competitor match could still drive a pricing recommendation; (4) `services/agentExecution/executionService.js`'s `agentLimit()` had its risk-cap check replaced with `if (false)`, so an AI workforce agent capped at GREEN could in fact be asked to run a YELLOW/RED action. | **FIXED** | All 4 restored to their correct logic. Regression coverage: (1)/(3) already covered by existing `__tests__/revenue.test.js` assertions (`currentIsFresh`, "no recommendation from an unverified match") — now re-verified to actually fail when the check is removed; (2) the existing "re-matching never overrides a human decision" test was strengthened with a new assertion engineered to force a real status change if the fix weren't in place (a product brand edit that would create a `conflict:brand` for an already-human-confirmed competitor) — confirmed it fails without the fix and passes with it; (4) covered by the existing `AGENT_RISK_CAP` assertion. Full mutation-adversarial run: 43/43 killed after the fix. Full backend suite, frontend suite + build, and SDK suite all pass with no regressions. |

## Production validation (Phase E, re-run and extended for the public-launch pass)

| Suite | Result |
|---|---|
| `mcis/backend` (`npm test`: full + security + tenant + workflow suites) | All suites passing (includes the new `voiceDeviceRevocation.security.test.js`) |
| `mcis/backend` mutation-adversarial (`node scripts/mutation-test.js`) | 43 killed, 0 survived, 0 not applied — clean after fixing the 4 live gaps in P8 above |
| `mcis/sdk/js` (`node test.js`) | 11/11 checks passing |
| `mcis/frontend` (tests + `npm run build`) | 76/76 tests passing (was 71; +3 `RootRoute.test.js`, +1 `LandingPage.test.js`, +1 `WorkspacePage.test.js` execution-source assertion), build succeeds |
| `nexus` (`pytest -m "not live"`, Linux) | 169 passing; 6 failures + 6 collection errors — all pre-existing/environmental (Windows-only modules `pygetwindow`/`pyautogui`; 3 of the 6 failures need outbound network to `example.com`, which this sandbox's own policy blocks). No `nexus/` file was touched in this pass, so this is the same pre-existing Linux limitation documented before, not a regression — see `LIMITATIONS.md` |
| Secret scan | Passing as part of the backend suite — no generated secret found in any response/audit row/log line |
| Live desktop/browser automation | Not run, per the governing instruction |

## Commercial productization pass (revenue generation / first-paying-customer readiness)

Turns the existing Layer 10 competitor-intelligence/revenue subsystem into
something a real company can sign up for, pay for, and get first value
from — reusing the existing architecture, security and honesty guarantees
throughout; no parallel workflow engine, no fake integrations, no fake
Stripe state, no new browser-automation path.

| # | Finding / addition | Status | Evidence |
|---|---|---|---|
| C1 | AI-business-analysis digest + customer value view (no LLM, no fabricated numbers) | DONE (earlier session of this pass) | `competitorService.js` `insightsDigest()`/`value()`; `GET /competitors/insights`, `GET /competitors/value`; `revenue.test.js` P2-5b |
| C2 | Competitor-specific workflow template bound to the real monitoring/recommendation data, using the existing workflow engine only | DONE | New `competitor_price_change_response` template in `services/templates/catalog.js` (verify → insight → draft notification → human review → final response plan); zero required connectors so it's usable with no external setup; never changes a price/stock/order automatically. `revenue.test.js` P8-6 |
| C3 | Explicit DEMO / SAMPLE DATA for first-value onboarding, structurally isolated from real data | DONE | `competitorService.js` `seedDemo()`/`demoDetail()`/`clearDemo()`; `POST/GET/DELETE /competitors/demo`; every normal read model (`listProducts`, `dashboard`, `insightsDigest`, `value`, `report`) excludes demo products/monitors by construction, not just by a UI label — verified by a test that seeds demo data and asserts the real `value()`/`insightsDigest()` numbers are unchanged. `revenue.test.js` P2-5c |
| C4 | Reports/export surface (monitoring summary, price-change, stock-change, recommendations, alert history; JSON or CSV) | DONE | `competitorService.js` `report()`; `GET /competitors/reports?type=&days=&format=`; workspace-scoped, demo-excluded, no raw page content or secrets; metered (see C5). `revenue.test.js` P2-5c |
| C5 | Storage/export usage dimension for billing | DONE | New optional capability `reports_generated` in `services/billing/plans.js` (same metered pattern as `monitoring_checks`); migration `20261009_layer10_commercial.up/down.sql` extends the `usage_events` metric check constraint and seeds default limits on the built-in plans — one authoritative entitlement model, nothing client-controlled |
| C6 | Customer-facing packaging / pricing | DONE (reused, not duplicated) | `BillingPage.jsx` already rendered real plans from `GET /billing/plans`; extended its per-plan line to surface the `max_monitored_products` limit when a plan configures it (never invented for a plan that doesn't). No second pricing authority was created. `BillingPage.test.js` new assertion |
| C7 | First-value / onboarding flow specific to competitor monitoring | DONE | New `CompetitorQuickStart` in `OnboardingPage.jsx`, shown at the "done" step for the "Monitoring & alerts" use case: add product → add competitor (creates its monitor) → check now (shows the real VERIFIED/UNVERIFIED/STALE/UNAVAILABLE result) → enable a free in-app alert — calls the same already-tested revenue endpoints, no new onboarding backend state. `OnboardingPage.test.js` new test |
| C8 | Core positioning / product-loop copy, pricing link, no dead-end buttons | DONE | `LandingPage.jsx`: added the "monitor → understand → safely automate" positioning line and a MONITOR→UNDERSTAND→ACT→CONTROL→PAY strip; added a "Pricing" link to `/billing` in the header, hero and footer. `LandingPage.test.js` new assertion; existing no-overclaim test still passes |
| C9 | Security regression across the new surface | VERIFIED — no weakening found | Full mutation-adversarial suite re-run after all changes: 43/43 killed, 0 survived, 0 not applied. New endpoints reuse `workspaceContext`/`requireAdmin`/tenant-scoped `store` exactly like every existing revenue endpoint — no parallel auth path |

### Still missing (honestly out of scope for this pass)

- A dedicated STARTER/GROWTH/BUSINESS *rename* of the plan tiers — the
  real plans (`free`/`pro`/`business`/`enterprise`) already carry the
  right shape and limits and are shown honestly; renaming them is a
  product-marketing decision, not a technical gap.
- A standalone public (pre-login) pricing page — `/billing` is
  authenticated like the rest of the app, consistent with the existing
  onboarding/workspace pages; building a logged-out marketing version was
  judged lower priority than the demo data, reports and workflow template
  above given the time available.
- Reports are computed on demand (no persisted report history/scheduling
  UI yet) — the `reports_generated` usage dimension meters generation,
  not storage of past reports.

### Production validation (commercial pass)

| Suite | Result |
|---|---|
| `mcis/backend` (`npm test`) | 53 + 7 passing, 0 failed |
| `mcis/backend` mutation-adversarial | 43 killed, 0 survived, 0 not applied |
| `mcis/sdk/js` | 11/11 checks passing |
| `mcis/frontend` (tests + `npm run build`) | 81/81 tests passing (was 77; +1 Revenue.test.js, +1 Billing, +1 Landing, +1 Onboarding), build succeeds |
| `nexus` (`pytest -m "not live"`, Linux) | 169 passing, 6 failed — identical, pre-existing Windows/network limitation; no `nexus/` file touched |
| Secret scan | Clean |
| Live desktop/browser automation | Not run, per the governing instruction |

## Before you ship

- [ ] Re-run `node scripts/check-config.js` against your actual production
      environment variables (not just the example file).
- [ ] Decide and explicitly set `PERMISSIONS_ENFORCED` and `BILLING_ENABLED`
      for your deployment (see `CUSTOMER_SETUP.md` §3).
- [ ] Confirm `ALLOWED_ORIGINS` lists only your real frontend origin(s).
- [ ] Read `LIMITATIONS.md` and decide whether any open item there blocks
      your specific launch (most don't block a controlled beta; see the
      final launch recommendation).
