# Deployment guide

## Components

This project has three independently-deployable pieces:

| Component | What it is | Where |
|---|---|---|
| `mcis/backend` | Node/Express API server | this directory's parent |
| `mcis/frontend` | React (Create React App) web UI | `mcis/frontend` |
| `nexus` | Python FastAPI bridge for voice/desktop/browser automation | `nexus` |

They're deployed separately and talk to each other over HTTP (frontend
→ backend → Nexus); none of them need to live on the same host.

## Backend (`mcis/backend`)

### Required configuration

Copy `.env.example` to `.env` and fill in real values. At minimum, in
**production**, `SUPABASE_URL` and `SUPABASE_KEY` must be set — the
server now validates this at startup (`config/validateConfig.js`) and
refuses to start in production with either missing, instead of
starting up and failing unpredictably on the first request that
touches the database. Outside production this is a warning, not a
blocker, so local dev/test can run with a partial `.env`.

Everything else in `.env.example` is either optional (a specific
feature is disabled without it — e.g. no `GITHUB_TOKEN_ENCRYPTION_KEY`
means GitHub connect/push can't be used) or has a safe default (e.g.
`DAILY_MESSAGE_LIMIT`).

### Health check

`GET /health` exists for liveness/readiness probes and requires no
authentication (see `middleware/auth.js`'s `publicApiPaths`). Point
your platform's health check at this endpoint rather than any
authenticated route.

### Worker / process requirements

This is a single Node process (`node server.js`) with no background
worker processes, cron jobs, or queues of its own — scale it
horizontally behind a load balancer if needed; there's no
process-local state that would make that unsafe (daily-limit counters
and similar live in Supabase, not in memory).

### Running it

```bash
cd mcis/backend
npm ci
npm start          # node server.js
# or, for local development with auto-reload:
npm run dev        # nodemon server.js
```

### Running the test suite

```bash
cd mcis/backend
npm test           # regression + security-hardening suites
```

Both suites set their own dummy credentials and mock every external
call (Supabase, Firebase, Groq, Nexus, GitHub) — no real `.env` is
needed to run them. See `.github/workflows/ci.yml` for how this is
wired into CI.

### Error monitoring (optional)

Set `SENTRY_DSN` to enable Sentry error reporting (`config/sentry.js`)
— this is entirely optional and the server runs identically without
it (nothing Sentry-related executes with no DSN configured).

### Credential rotation

Both of this backend's sensitive long-lived credentials support a
rotation window where the old value keeps working while the new one
takes over, instead of a flag day that breaks every existing
connection/device the moment you rotate:

- **`GITHUB_TOKEN_ENCRYPTION_KEY`** (encrypts stored GitHub OAuth
  tokens) — set the new key as `GITHUB_TOKEN_ENCRYPTION_KEY` and the
  old one as `GITHUB_TOKEN_ENCRYPTION_KEY_PREVIOUS`. New tokens encrypt
  under the new key immediately; existing tokens keep decrypting via
  the old key until they're naturally re-encrypted (next GitHub
  reconnect). See the full procedure documented at the top of
  `security-engine/credentialEncryption.js`.
- **`NEXUS_VOICE_DEVICE_TOKEN`** (the voice device's shared secret) —
  set the new token as `NEXUS_VOICE_DEVICE_TOKEN` and the old one as
  `NEXUS_VOICE_DEVICE_TOKEN_PREVIOUS`. An already-paired device keeps
  authenticating with the old token until it's re-paired with the new
  one. See `backend-routing/resolveUserId.js`.

In both cases, once nothing still needs the old value, drop the
`_PREVIOUS` variable entirely to finish the rotation.

## Frontend (`mcis/frontend`)

### Required configuration

Copy `.env.example` to `.env`. `REACT_APP_*` variables are baked in at
**build time** (Create React App), so changing `.env` requires a
rebuild, not just a restart of whatever serves the static files.

None of the Firebase web config values are secret — they're the
public client config Firebase expects to ship to the browser — but
`REACT_APP_API_URL`/`REACT_APP_BACKEND_URL` must point at your actual
backend deployment or the app will try to reach
`https://mcis-backend.onrender.com` (the hardcoded fallback baked into
several components).

### Building

```bash
cd mcis/frontend
npm ci
npm run build       # outputs to build/ — a static site, serve it with
                     # any static file host/CDN (no Node runtime needed
                     # to SERVE it, only to build it)
```

The build does not require any real backend/Firebase credentials to
succeed — it's a pure compile/bundle step; app logic (including
Firebase initialization) only runs in the browser at runtime.

## Containerized deployment (Docker)

Backend and frontend each have a production `Dockerfile`
(`mcis/backend/Dockerfile`, `mcis/frontend/Dockerfile`), and a root-level
`docker-compose.yml` wires the two together. This does **not** containerize
Supabase, Firebase, or Nexus — Supabase/Firebase are external managed
services you connect to over the network (see "Services you need before
you start" in `CUSTOMER_SETUP.md`), and Nexus is the separate,
Windows-only local agent described below, not a cloud deployment target.

```bash
cp mcis/backend/.env.example mcis/backend/.env.production    # fill in real values
cp mcis/frontend/.env.example mcis/frontend/.env.production  # fill in real values

# Apply migrations against your Supabase Postgres instance first --
# compose does not run them for you (see CUSTOMER_SETUP.md section 2).

docker compose --env-file mcis/frontend/.env.production build frontend
docker compose build backend
docker compose up -d

curl http://localhost:5051/health   # backend
curl http://localhost:8080/         # frontend (served by nginx)
```

Notes specific to this setup:

- The frontend's `REACT_APP_*` variables are Create React App build-time
  values (see "Required configuration" above) — they're passed as Docker
  build args, not container-start environment variables, which is why
  they come from `--env-file` on the `build` step rather than the
  backend's `env_file:` pattern.
- The backend image runs as a non-root user and defines a `HEALTHCHECK`
  against the same real `/health` route referenced throughout this
  document — not a synthetic check.
- `docker-compose.yml` does not include a Redis container:
  `services/cache.js` already treats Redis as dev-only/optional and
  degrades to "caching disabled" in production with no Redis reachable,
  so one isn't required for this to run correctly.
- This does not replace the plain `npm start`/`npm run build` path above
  — it's an additional, equally supported way to run the same code,
  useful for a platform that deploys from a container image (Fly.io,
  Railway, ECS, a VPS with Docker) rather than a buildpack.

## Nexus (`nexus`)

This is the one component that is **not** a typical cloud deployment
target — it's a local HTTP bridge meant to run on the same machine
whose desktop/browser it automates (that's the point: it clicks,
types, and reads the screen of the machine it runs on). It is not
designed to run in a container with no display, and most of its test
suite reflects that (see the P2 test-safety audit for exactly which
tests need a real desktop/display vs. which are safe anywhere).

### Required configuration

Copy `.env.example` to `.env`. **`NEXUS_DEVICE_TOKEN` is the one thing
that must be set** before this is reachable from anything other than
the exact same machine — with it unset, `api_server.py` now fails
closed (refuses every `/execute`/`/queue-status` request with a 503)
rather than the old default of silently accepting every request
unauthenticated. The only supported way to get the old permissive
behavior back for local development is the explicit
`NEXUS_ALLOW_UNSAFE_DEV=true` opt-in — never set that outside a
machine you're certain nothing else can reach.

### Network exposure

`NEXUS_BIND_HOST` defaults to `127.0.0.1` (localhost-only). Binding to
anything else (`0.0.0.0`, a real interface IP) without
`NEXUS_DEVICE_TOKEN` set is refused outright at startup — both the
network-binding and the auth-token checks are required together, not
as alternatives to each other.

### Running it

```bash
cd nexus
pip install -r requirements.txt   # full dependency set: Windows-only
                                   # packages included -- this must run
                                   # on the real target OS, not a
                                   # generic Linux container/CI runner
                                   # (see requirements-ci.txt for the
                                   # CI-safe subset used in automated
                                   # tests instead)
python api_server.py
```

### Health check

`GET /health` is intentionally left unauthenticated (no secrets, no
action execution — just a liveness signal), same reasoning as the
backend's `/health`.

## What CI does and does not validate

`.github/workflows/ci.yml` runs the backend's full test suite, a
curated safe subset of Nexus's tests (no live desktop/browser
automation, no Windows-only code paths), and a frontend build check —
all on a standard Linux GitHub-hosted runner. It explicitly does
**not** validate:

- Nexus's real desktop/browser/keyboard/mouse automation (needs a real
  Windows machine with a display — `pytest -m live`, run manually on
  real hardware).
- Real Firebase/Supabase/GitHub OAuth/Groq credentials (every backend
  test mocks these).
- Real Sentry delivery (no `SENTRY_DSN` is configured in CI; the
  scrubbing logic is unit-tested, but an actual event reaching a real
  Sentry project is not).
- Real billing/payment behavior (none exists yet — see `BILLING.md`).

These are all **EXTERNAL/ENVIRONMENT VALIDATION REQUIRED**: they need
real credentials, a real Windows/GUI machine, or both, which a hosted
CI runner and this development pass do not have.
