# Security model

This document describes what is actually enforced in this codebase today,
and is written from direct verification (reading the code, running the
tests, or both) rather than from design intent. Where something is a known
gap, it's listed as one in `LIMITATIONS.md` rather than glossed over here.

## Reporting a vulnerability

There is no dedicated security-disclosure inbox or bug-bounty program set
up for this project yet. Until one exists, report a suspected
vulnerability directly to whoever operates your deployment, privately, not
as a public issue.

## Identity and authorization

- **Backend API** (`mcis/backend`): Firebase ID tokens, verified server-side
  (`middleware/auth.js`). Mounted globally (`app.use('/api',
  authenticateFirebaseUser)`) ahead of every resource router.
- **Cross-user access**: the global auth middleware extracts any user id
  embedded in the request path (`getUserIdsFromApiPath`) and rejects a
  request whose path-embedded id doesn't match the authenticated caller,
  before any route handler runs. This is necessarily a hand-maintained
  pattern list — a path shape it doesn't recognize gets no protection from
  it. Routes that take a `:userId` directly are expected to also assert
  ownership inline in the handler itself (see `mcis/backend/routes/goals.js`
  for the current reference implementation, added after exactly this kind
  of gap was found and fixed there — see `LAUNCH_CHECKLIST.md`). Don't rely
  on the shared pattern list alone for a new `:userId` route.
- **Multi-tenancy** (workspaces): every tenant-scoped read/write goes
  through `services/workspaceService.js`'s `resolveContext()`. A
  non-member gets `404`, never `403` (membership itself isn't disclosed).
  Full model in `mcis/backend/docs/LAYER1_MULTI_TENANT.md`.
- **Voice / local-device surface**: the handful of routes a local voice
  client calls (`/api/command`, `/api/permissions/grant`,
  `/api/emergency/stop|resume`, …) authenticate with a **shared device
  secret** (`NEXUS_VOICE_DEVICE_TOKEN`) instead of a Firebase token —
  documented in `mcis/backend/security-engine/callerIdentity.js`. Every
  holder of that one shared secret is treated as **one principal**: the
  `deviceId` a client sends alongside it is unauthenticated and
  client-supplied, so it is never trusted as a security boundary in either
  direction (two different physical devices sharing the token are the same
  principal; a single device can't claim to be two). Token rotation is
  supported (`NEXUS_VOICE_DEVICE_TOKEN_PREVIOUS`) so a backend restart with
  a new token doesn't lock out an already-paired device mid-rotation. The
  shared secret itself is still **not per-device issued** — there is one
  credential for the whole fleet, not one per physical device — but a
  specific device's known `deviceId` can now be **revoked** individually
  (`NEXUS_VOICE_DEVICE_REVOKED_IDS`, comma-separated), so a known
  compromised or lost device can be shut off without rotating the secret
  for every other device. The check runs identically in both independent
  copies of this resolver (`backend-routing/resolveUserId.js` and
  `security-engine/callerIdentity.js`) and only after the shared secret
  itself has already been validated, so a caller presenting the wrong
  secret can never learn whether a given `deviceId` is revoked. Full
  compromise of the shared secret itself (not a single known device) still
  requires rotating the token for everyone — see `LIMITATIONS.md`.
- **API keys** (Layer 6, for programmatic/automation access): scoped,
  revocable, bound to one workspace; usage is metered the same as
  interactive calls.

## High-risk / sensitive-action approval

- **Node backend (Agent Firewall)**: every connector/workflow action a
  workspace's agent takes is classified by risk (`RED_ACTIONS` in
  `backend-routing/riskModel.js` for the voice/command surface; a separate
  GREEN/YELLOW/RED tiering for Layer 5/10 connector actions). A `RED`
  action is denied before it reaches the computer; others may require an
  explicit approval ticket depending on workspace policy. Tickets are
  single-use and not transferable across executions or workspaces.
- **Nexus (local desktop/browser/terminal executor)**: high-risk actions
  (`HIGH_RISK_ACTIONS` in `nexus/common/approval.py` — file/process
  mutation, `run_terminal`, `start_process`/`restart_process`, `close_app`,
  `send`/`submit`/`pay`/`login`, …) require a cryptographically bound,
  single-use, short-lived HMAC-SHA256 approval token
  (`issue_approval_token`/`verify_approval_token`), minted only at the
  moment a human actually confirms the action. A token is bound to the
  exact action (platform, action name, target, value, parameters, risk)
  plus the caller/workspace — it cannot be replayed against a different
  action, a different input, or a different caller/workspace, and it
  cannot be forged by an LLM-planned step supplying its own token string.
  This is enforced per-executor (`ApprovalGate.ensure_allowed`), not only
  at a shared gateway, so a direct call to a platform executor is still
  gated.
- **These two approval mechanisms are independently maintained** (one
  Python set, one JS set) and must be kept in sync by hand for any new
  high-risk action added on either side — a gap in both previously let
  `start_process`/`restart_process` run with no approval at all; now
  fixed and covered by adversarial tests on both sides.
- **Emergency stop** is scoped two different ways depending on the
  surface: the voice/command surface's stop is scoped to the *calling
  principal* (so it does not silently stop a different caller's work —
  but remember all holders of the shared voice-device token are one
  principal); the workspace execution surface's stop
  (`services/agentExecution/executionService.js`) is scoped to the
  *workspace* and enforced by the Agent Firewall. The two are intentionally
  decoupled — the voice-side stop does not reach Layer 3/4 execution at all.

## Input handling / injection

- Content from an external source — a document, a web page, an email, a
  connector's API response — is treated as **data**, never as instructions:
  it cannot add workflow steps, change approvals, or alter policy/role
  assignment on its own, and a write derived from it still waits for human
  approval like any other sensitive step. Covered by dedicated adversarial
  tests (`P7-1`, `P20-1`, "prompt / tool injection" in
  `__tests__/hardening.test.js`/`__tests__/revenue.test.js`).

## Network egress (SSRF)

- Outbound calls the backend makes on a caller's behalf (the generic HTTP
  connector, Google Drive OAuth, webhook registration) are checked against
  an allowlist/denylist for public-vs-private addresses before the call is
  made, and redirects are not blindly followed. `services/integrations/safeHttp.js`.
- The Nexus browser automation layer has its own navigation-policy guard
  (`BrowserNavigationPolicy` / `install_navigation_guard`) that manually
  chases redirects one hop at a time so a server-redirect to a disallowed
  host is still caught (Playwright's own `route.continue_()` does not
  re-invoke the handler on a redirect's follow-up request, which is why
  this isn't simply "use the built-in redirect handling").

## Secrets

- Integration credentials are encrypted at rest (`services/integrations/credentialService.js`),
  with supported key rotation that re-encrypts every credential under a new
  key without downtime.
- Every test suite includes a secret-scan pass (`scripts/secret-scan.js`,
  exercised in `__tests__/hardening.test.js` / `__tests__/revenue.test.js`)
  asserting no generated secret — API key, webhook secret, refresh token,
  Stripe key — ever appears in a response body, audit row, prompt, or log
  line. A one-time webhook-secret reveal at creation time is the one
  intentional exception, and it is never shown again after that.

## Production configuration (fail-closed)

- `config/validateConfig.js` refuses to start in production if a required
  variable (`SUPABASE_URL`, `SUPABASE_KEY`) is missing, or if a
  security-relevant switch that must be *explicit* in production
  (currently `PERMISSIONS_ENFORCED`) is unset or set to anything other than
  a literal `"true"`/`"false"`. An explicit `"false"` is accepted as a
  deliberate operator choice (voice clients currently have no UI for a
  first-time permission grant) — the point is that it must be a choice,
  not a silent default.
- `services/config/productionConfig.js` / `scripts/check-config.js` mirror
  the same checks for a pre-deploy audit tool, and never print a value —
  only which settings are missing/misconfigured.
- `ALLOWED_ORIGINS` is explicitly validated in production: no `"*"`, no
  `localhost`, and CORS fails closed (an unrecognized origin is rejected,
  not silently allowed).
- `ALLOW_UNAUTHENTICATED_API=true` is hard-ignored whenever
  `NODE_ENV=production`, logged once so a stray dev-env leftover gets
  noticed, and this guard is applied the same way at every call site that
  reads that variable.

## Process-level hardening

- Graceful shutdown (`config/gracefulShutdown.js`): on `SIGTERM`/`SIGINT`,
  stops accepting new work, lets in-flight requests finish (bounded by a
  timeout), stops the workflow/revenue workers and retention timer, closes
  idle WebSocket/HTTP connections, and force-exits if any step hangs —
  rather than the process previously having no shutdown handling at all.

## What this document does not cover

Known, current gaps and un-built protections are in `LIMITATIONS.md`, not
here — this file describes what *is* enforced, so it stays trustworthy as
a list of real guarantees rather than aspirational ones.
