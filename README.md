# Nexus / MCIS

Nexus (also called MCIS in parts of this codebase and its database) is an AI
workspace platform: a web app with persistent memory, goals and chat
(`mcis/frontend`, `mcis/backend`), a workspace/agent/workflow layer that lets
a team connect real tools and let an AI agent carry out approved work inside
permissions they control (`mcis/backend/services/*`, documented per layer in
`mcis/backend/docs/`), and an optional local execution agent for desktop,
browser and voice automation on a user's own Windows machine (`nexus/`,
`mcis-agent/`).

This README is the map. For anything beyond "where do I start," the
per-topic documents below are more complete and more current than a summary
here could stay.

## What's in this repo

| Path | What it is |
|---|---|
| `mcis/backend` | Node/Express API: auth, chat, memory, goals, workspaces, workflows, connectors/integrations, billing, revenue/monitoring tooling, security engine. |
| `mcis/frontend` | React (CRA) app: chat UI, settings, data controls, billing, and the Layer 8 customer-journey pages (landing, onboarding, workspace, developers). |
| `nexus/` | Python execution platform for desktop/browser automation and the voice pipeline. Windows-only (UI automation, screenshots, native app control need an interactive Windows desktop session). Has its own `README.md` and `docs/`. |
| `mcis-agent/mcis-agent-final` | Local desktop agent: wake-word/voice capture, device pairing, and the bridge that sends commands to the backend. |

## Documentation map

- **This file** — what's here, how to run it, where to look next.
- **`SECURITY.md`** — the security model: what's enforced, what every
  security-hardening pass in this repo actually fixed, and what hasn't been
  built yet.
- **`PRIVACY.md`** — what user data exists, where it's stored, and the
  export/delete controls a user has over it.
- **`API.md`** — how to reach this platform from your own code (the real,
  key-authenticated automation API; this is distinct from the browser
  session the frontend uses).
- **`CUSTOMER_SETUP.md`** — how to actually stand this up: required
  services, environment variables, first-run steps.
- **`LAUNCH_CHECKLIST.md`** — the pre-launch audit trail for this specific
  hardening pass: what was found, what was fixed, what's still open.
- **`LIMITATIONS.md`** — a plain list of what this product does not do yet,
  so "we don't support that" is one lookup away instead of a surprise.
- **`mcis/backend/docs/LAYER*.md`** — one document per backend subsystem
  (multi-tenancy, workspace data scoping, agent execution, workflows,
  integrations, security/firewall, billing, customer journey, hardening
  pass notes, revenue/monitoring suite). These are the most detailed and
  most accurate description of how each system actually works — read the
  relevant one before changing that system.
- **`nexus/README.md` and `nexus/docs/`** — the execution platform's own
  architecture, supported actions, and development rules.

## Running it

See `CUSTOMER_SETUP.md` for the full walkthrough (required services,
`.env` variables, first-run checks). The short version:

```bash
# Backend
cd mcis/backend
cp .env.example .env   # fill in real values — see CUSTOMER_SETUP.md
npm install
npm test                # plain Node + assert, no framework
npm start

# Frontend
cd mcis/frontend
npm install
npm test
npm start
```

Nexus (the desktop execution agent) is Windows-only and set up separately —
see `nexus/README.md`.

## Testing conventions (read before adding a test)

- **Backend** (`mcis/backend`): plain Node + `assert`, no test framework —
  keep it that way. `npm test` runs every suite in sequence (see
  `package.json`'s `test` script for the exact list and order).
- **Frontend** (`mcis/frontend`): React Testing Library, run with
  `CI=true npx react-scripts test --watchAll=false`.
- **Nexus** (`nexus/`): pytest, Windows-targeted. On a non-Windows machine,
  `py -m pytest -m "not live" -q --continue-on-collection-errors` runs the
  subset that doesn't need Windows-only packages (`pywin32`, `pygetwindow`,
  `pyautogui`); the rest fail to collect there, which is a known,
  documented limitation, not a bug in those tests. Tests marked `live` run
  real local automation (safe, local-only targets) and are never run
  unattended or in CI.

## Repository rules

See `CLAUDE.md` for the rules that govern changes to this codebase
(frozen subsystems, multi-tenancy requirements, schema-migration
conventions). They apply to every change, human or AI-assisted.
