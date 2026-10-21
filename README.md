# Automation-MCIS / Nexus

Voice- and web-driven AI automation for operations teams: agents that run browser and
desktop tasks, with approvals for risky actions, workflows, audit trails and per-workspace
usage.

| Folder | What it is |
|---|---|
| `mcis/backend` | Node/Express API: auth, workspaces, agent executions, workflows, integrations, security, billing/metering, monitoring. |
| `mcis/frontend` | The original MCIS web app (React). |
| `nexus-web` | Nexus web console — B2B dashboard for agents, tasks, approvals, workflows, team and usage. |
| `mcis-agent/mcis-agent-final` | Desktop agent ("Hey MCIS" wake word, device pairing). |
| `nexus` | Python execution engine (Windows): browser/desktop automation, planner, recovery, evidence. |

## Quick start

```bash
cd mcis/backend && npm ci && cp .env.example .env && npm start      # :5051
cd nexus-web    && npm ci && cp .env.example .env.local && npm run dev  # :5174
```

Fill in the `.env` files first (names are listed in each `.env.example`; never commit the
filled-in files). Apply the SQL migrations in `mcis/backend/migrations` in date order
(`20261004_service_role_table_grants` last — see `mcis/backend/docs/PRODUCTION_CONFIG.md`).

## Docs

- Launch status: [`docs/FINAL_LAUNCH_READINESS.md`](docs/FINAL_LAUNCH_READINESS.md)
- Audit: [`docs/FINAL_ENGINEERING_AUDIT.md`](docs/FINAL_ENGINEERING_AUDIT.md)
- Security: [`SECURITY.md`](SECURITY.md) · Limitations: [`LIMITATIONS.md`](LIMITATIONS.md)
- Production config / runbook: `mcis/backend/docs/PRODUCTION_CONFIG.md`, `PRODUCTION_RUNBOOK.md`
- Nexus console: [`nexus-web/README.md`](nexus-web/README.md)

## Tests

```bash
cd mcis/backend && npm test     # backend
cd nexus-web && npm test        # console
cd mcis/frontend && npm test    # MCIS app
cd nexus && py -m pytest -m "not live" -q   # engine (Windows)
```
