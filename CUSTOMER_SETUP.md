# Customer / operator setup

This is the walkthrough for standing up your own deployment. For the exact
list of every environment variable this backend reads, **`mcis/backend/.env.example`
is the source of truth** — every name in it is reconciled against the real
code that reads it, with inline notes on what's required vs. optional and
why. This document is the narrative around that file, not a copy of it.

## 1. Services you need before you start

| Service | Used for | Required? |
|---|---|---|
| Supabase (Postgres) | Primary datastore — every table this product has | Yes |
| Firebase project (Auth) | Sign-up/sign-in, email verification, password reset | Yes |
| Groq API key | Legacy chat/AI features — the server fails to boot certain modules without it even if you don't use that surface | Yes, today |
| Gemini API key | Agent/voice plan execution (the planner model) | Required for agent/voice features |
| A payment provider (Stripe), or nothing | Workspace billing (Layer 7/8) | Optional — `BILLING_ENABLED=false` and no provider configured is a fully supported "no payments yet" state; see `mcis/backend/docs/LAYER7_BILLING.md` |
| GitHub OAuth app | GitHub connector (connect + push) | Optional |
| Google Cloud OAuth credentials | Google Drive connector | Optional |
| Cloudinary (or your own media provider) | File/image uploads | Optional, feature-dependent |

Nothing in this list is faked if you skip it — a missing optional service
means that one feature reports itself as unavailable (and says so), not a
silent broken state pretending to work. A missing *required* service means
the server refuses to start in production (see `SECURITY.md`'s
"Production configuration" section) rather than booting into a broken
half-working state.

## 2. First-run steps

```bash
cd mcis/backend
cp .env.example .env
# Fill in: SUPABASE_URL, SUPABASE_KEY (service-role key, not anon/public),
# FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY (or
# a service-account file/JSON — see the Firebase Admin section of
# .env.example for the exact alternatives), GROQ_API_KEY, GEMINI_API_KEY.
npm install
node scripts/check-config.js    # run this BEFORE npm start — it's the
                                 # automated version of "did I configure
                                 # this correctly," and never prints a
                                 # secret value, only what's
                                 # missing/misconfigured
npm test                        # full backend suite; expect every
                                 # suite to pass before you deploy
npm start
```

```bash
cd mcis/frontend
npm install
# Set REACT_APP_API_URL to your backend's real URL (defaults to the
# hosted demo backend otherwise, which you do not want for your own
# deployment)
npm test
npm run build   # or `npm start` for local development
```

Apply database migrations in `mcis/backend/migrations/` in order (each is
an idempotent `*.up.sql`/`*.down.sql` pair) before first boot.

## 3. Decisions you need to make before launch

These aren't bugs to fix — they're configuration choices this product
deliberately leaves to the operator rather than guessing on your behalf:

- **`PERMISSIONS_ENFORCED`** — must be explicitly `"true"` or `"false"` in
  production (the server won't start otherwise). `"false"` is a real,
  supported choice if you're not yet ready for the voice client's current
  UX limitation around first-time approval grants (see `.env.example`'s
  comment on this variable and `mcis/backend/docs/SECURITY_FIXES_PRE_LAYER2.md`).
- **`BILLING_ENABLED`** and which provider (`STRIPE_ENABLED` vs.
  `BILLING_PROVIDER=generic` vs. neither) — decide whether you're
  launching with real payments on day one or adding them later; either is
  fully supported, see `mcis/backend/docs/LAYER7_BILLING.md` and
  `BILLING.md`.
- **`ALLOWED_ORIGINS`** — the exact, explicit list of frontend origins
  allowed to call your API with credentials. No wildcards, no localhost,
  in production.
- **`INTEGRATIONS_ENABLED`** / the connectors you actually want available
  to your customers — each connector is off until explicitly enabled and
  configured; turning on `INTEGRATIONS_ENABLED` without configuring
  `INTEGRATION_ENCRYPTION_KEY` will fail the production config check
  rather than silently storing credentials insecurely.

## 4. Verifying your deployment is actually healthy

- `node scripts/check-config.js` — configuration correctness, no secrets
  printed.
- `GET /api/automation/v1/openapi.json` — confirms the automation API is
  up and shows exactly what it currently exposes.
- The ops readiness endpoint (`routes/ops.js`'s readiness handler) — worker
  heartbeats, DB reachability.
- Send `SIGTERM` to the running process in a staging environment once and
  confirm it exits cleanly within your configured `SHUTDOWN_TIMEOUT_MS`
  rather than being force-killed — see `SECURITY.md`'s "Process-level
  hardening."

## 5. The optional local execution agent (Nexus / mcis-agent)

Desktop/browser automation and the voice pipeline are a **separate,
Windows-only, opt-in component** your customers' end users install locally
— they are not required to use the core web product (chat, memory, goals,
workspaces, workflows, connectors). See `nexus/README.md` and
`mcis-agent/mcis-agent-final/` for that setup, and `LIMITATIONS.md` for
what this component does and doesn't support today.
