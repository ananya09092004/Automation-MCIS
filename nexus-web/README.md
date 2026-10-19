# Nexus web console

The B2B operations console for Nexus: AI agents, tasks, workflows, approvals,
integrations, activity, usage and team management for a workspace.

It is a **separate app** from the original MCIS application in
`mcis/frontend` (which is unchanged). Both use the same backend
(`mcis/backend`) and the same Firebase project for sign-in.

## What it does (all against the real backend)

| Page | Backend API | Notes |
|---|---|---|
| Dashboard | `GET /api/workspaces/:ws/overview`, `GET …/agents` | Server-computed counts, success rate, approvals, usage (30 d), connectors, tasks. |
| AI Agents | `GET/POST …/agents` | Create is admin-only (server-enforced). Hidden if the module is off. |
| Tasks | `GET/POST …/executions`, `GET …/:id`, `GET …/:id/evidence`, `POST …/:id/cancel` | "Ask Nexus" starts a real execution with an idempotency key. |
| Approvals | executions + `GET …/workflow-runs`, approve / reject endpoints | Role, expiry and separation of duties are enforced by the server; refusals are shown verbatim. |
| Workflows | `GET …/workflows`, versions, `POST …/:id/runs`, `GET …/workflow-runs` | Runs the **active** version with typed inputs. Building workflows stays in the MCIS app. |
| Integrations | `GET …/integrations`, `POST …/:id/health` | Shows "not enabled on this server" when `INTEGRATIONS_ENABLED` is off. Connecting (credential entry) stays in the MCIS app. |
| Activity | `GET …/audit`, `GET …/security/events` | Owners / admins only. |
| Usage & Billing | `GET …/billing`, overview usage | Shows **Not configured** when no payment provider is set. No prices or invoices are invented. |
| Team | members, invitations | Without an email provider, the one-time invite code is shown once. |
| Settings | `GET /api/device/list`, `DELETE /api/device/:id`, `GET …/security`, `POST …/security/emergency-stop` | Paired desktop devices (revoke), firewall status, emergency stop. |

## Run locally

```bash
cd nexus-web
npm ci
cp .env.example .env.local      # fill in the VITE_FIREBASE_* values (names below)
npm run dev                     # http://localhost:5174 — /api is proxied to http://localhost:5051
```

Start the backend first (`cd mcis/backend && npm start`, port 5051). To proxy
somewhere else, set `NEXUS_DEV_API_TARGET`.

Without the Firebase variables the app shows a "Configuration required" screen
listing the missing variable **names**.

## Environment variables (names only)

| Variable | Required | Purpose |
|---|---|---|
| `VITE_FIREBASE_API_KEY` | yes | Firebase web app config (public client identifier) |
| `VITE_FIREBASE_AUTH_DOMAIN` | yes | 〃 |
| `VITE_FIREBASE_PROJECT_ID` | yes | Must be the project the backend verifies tokens for |
| `VITE_FIREBASE_APP_ID` | yes | 〃 |
| `VITE_FIREBASE_STORAGE_BUCKET`, `VITE_FIREBASE_MESSAGING_SENDER_ID` | no | Optional Firebase fields |
| `VITE_API_URL` | production | Backend origin, e.g. `https://api.example.com`. Empty = same origin (`/api`). |
| `NEXUS_DEV_API_TARGET` | no | Dev-server proxy target (not shipped to the browser) |

Everything prefixed `VITE_` is compiled into the browser bundle. **Never** put
server secrets (Supabase service-role key, API keys, encryption keys) here —
the console never talks to Supabase directly.

## Production

```bash
npm run build      # → dist/
```

- Host `dist/` on any static host. Unknown paths must rewrite to `/index.html`
  (`vercel.json` does this on Vercel).
- Add the console's origin to the backend's `ALLOWED_ORIGINS`.
- Users sign in with the same Firebase accounts as the MCIS app (email/password
  or Google, whichever is enabled in the Firebase project).

## Tests

```bash
npm test           # 33 unit/UI tests (Vitest + Testing Library, fake API)
npm run test:e2e   # live end-to-end against a running backend — see e2e/README.md
```

## Security notes

- The Firebase ID token is attached **only** to requests for the configured API
  (`<VITE_API_URL>/api/…`); the client refuses any other path.
- No credentials are stored by the app (Firebase manages its own session).
  `localStorage` holds only the selected workspace id.
- All authorization is server-side; hidden buttons are a convenience, not a
  control. Members get 403 / 404 from the API for admin data.
