# CLAUDE.md — Automation-MCIS (Nexus)

## Repo map
- `mcis/backend/` — Node/Express 5 API (Firebase Auth → `middleware/auth.js`, Supabase via per-module `createClient`). Voice/command hot path: `backend-routing/` (`commandRoute.js`, `taskPlanner.js`, `riskModel.js`), `agentSocket.js`.
- `mcis/frontend/` — React (CRA) dashboard.
- `mcis-agent/mcis-agent-final/` — local desktop agent (wake word, pairing, commands).
- `nexus/` — Python execution platform (browser/desktop automation, voice pipeline, planner, recovery). Windows-targeted.

## Tests
- Backend: `cd mcis/backend && npm test` (plain Node + assert, no framework — keep it that way).
- Nexus: `cd nexus && py -m pytest -m "not live" -q` on Windows. Many modules need Windows-only deps (`winreg`, `pywin32`, Playwright browsers); on Linux most tests fail to collect.

## Rules
- Don't touch voice/wake-word/transcription, planner/recovery, or risk/permission/privacy code unless the task is about them. Add no synchronous work to `/api/command`, `/api/voice` or the agent socket.
- Don't add fake integrations or secrets. Don't push to GitHub unless asked.
- Multi-tenancy (Layer 1) is described in `mcis/backend/docs/LAYER1_MULTI_TENANT.md`. All tenant access goes through `services/workspaceService.js` → `resolveContext()`. Non-members get 404.
- Schema changes go in `mcis/backend/migrations/` as an idempotent `*.up.sql` and `*.down.sql` pair.
