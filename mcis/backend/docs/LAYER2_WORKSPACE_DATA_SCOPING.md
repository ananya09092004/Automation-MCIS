# Layer 2 — Workspace Data Scoping & Collaboration Foundation

Status: implemented 2026-09-23. Requires Layer 1 (workspaces) and Layer 3 (agent executions).

```
Workspace → People (Layer 1 roles) → Tasks → AI agent Executions (Layer 3) → Steps → Evidence
```

## 1. Data ownership inventory

This inventory covers every persistent, user-owned resource the backend touches. The decisions follow the rule "don't blindly add workspace_id": only business data that must not cross tenants is scoped.

| Resource (table) | Owner model after Layer 2 | Who can access | Notes |
|---|---|---|---|
| **Chat sessions** (`chats`) | workspace + creator | the creator, in that workspace only | Scoped. Previously any user could rename or delete any chat id. |
| **Messages** (`conversations`) | workspace + creator | only through an accessible session | Scoped. Previously any message id could be edited. |
| **Memory** (`user_memories`, `memory_vectors`) | workspace + creator | the creator, in that workspace only | Scoped, including vector search (`search_memories_scoped`). Previously a delete removed *every* user's vectors that had the same text, and NL-delete trusted IDs chosen by the LLM. |
| **Goals** (`goals`) and **smart goals** (`goal_breakdowns`) | workspace + creator | the creator, in that workspace only | Scoped. Sub-records (`goal_updates`, `goal_reviews`) are reached only through an owned goal. Previously PATCH/DELETE `/:goalId` and review/adapt accepted any id. |
| **Tasks** (`workspace_tasks`, `workspace_task_activity`) | workspace | all members (see role rules) | New in this layer. |
| **Executions, steps, evidence, approvals** | workspace (Layer 3) | members; approval rules come from Layer 3 | Linked to tasks via `agent_executions.task_id` using a composite FK. |
| **Workspace resource grants** (`workspace_permission_grants`) | workspace | members can read; admin+ can write | New. Used by Layer 3 when `PERMISSIONS_ENFORCED=true`. |
| **Device/voice grants** (`user_permissions`) | principal (legacy) | the voice/device path | **Unchanged.** It keeps serving the frozen voice flow. It is never consulted for workspace executions. |
| **Audit** (`audit_log`) | + `workspace_id` attribution | admin+ can read their workspace's rows | Existing 4-argument writers (voice) are unchanged. |
| Notifications (`notifications`) | user (private inbox) | owner | Not workspace data. Owner check added on read/delete (see limitations). |
| Daily plans (`daily_execution_plan`) | user (personal planner) | owner | Not workspace data. Owner check added to complete-task. |
| Profiles, preferences, intelligence, twin, timeline, knowledge graph, coding profile, behaviour patterns, analytics | user (personal) | owner, through existing uid-guarded routes | **Not scoped.** Derived per-person personalisation (see limitations). |
| Uploaded documents (`pdf_vectors`) | user | owner | **Not scoped yet.** Needs two more scoped RPCs (see next steps). |
| Device tokens, pairing sessions | user/device | owner | Device identity, not workspace data. |
| Workspaces, members, invitations | Layer 1 | Layer 1 rules | Unchanged. |

## 2. How scoping works

- **`middleware/workspaceDataScope.js`** runs in front of `/api/chat`, `/api/memory` and `/api/goals` only. It is not mounted in front of `/api/command`, `/api/voice`, `/api/emergency`, `/api/permissions` or the agent socket, so voice is untouched.
- **Choosing a workspace:**
  - `X-Workspace-Id: <uuid>` selects a workspace the verified user is already a member of. Membership is checked through Layer 1; a non-member gets 404.
  - No header means the caller's personal workspace, so existing clients keep working unchanged.
  - The header only chooses among the caller's own memberships and is never trusted as authorization.
- **Scope storage.** The resolved scope `{userId, workspaceId, isPersonal}` is kept in `AsyncLocalStorage` (`services/workspaceScope.js`). The data-access functions (`database.js`, `memory.js`, `memoryManager`, `goalBreakdownService`, the goals, memory and chat routes) add the filter themselves. No function signatures changed, and every caller outside a scoped request keeps its exact old behaviour.
- **Row visibility:**
  - Team workspace: `workspace_id = W`.
  - Personal workspace: `workspace_id = P OR workspace_id IS NULL`. `NULL` means legacy rows and rows written by the voice pipeline.
  - Writes inside a scope set `workspace_id`. Unscoped writes (voice, cron jobs) leave it `NULL`, so they show up only in the owner's personal workspace.
- **Missing or foreign resources.** Cross-workspace or cross-user IDs return **404**. Chats, messages, memory, goals, smart goals and tasks all use the same not-found response.
- **Kill switch.** `WORKSPACE_DATA_SCOPING=off` turns the middleware into a pass-through, restoring pre-Layer-2 behaviour, for example during a rollback.
- **Personal-context cache.** The personal-workspace context is cached for 10 minutes per user. This is safe because a personal workspace can't be deleted and its owner can't be removed. Team workspaces are **never** cached, so role changes apply on the next request.

## 3. Collaboration: tasks

Mounted at `/api/workspaces/:workspaceId/tasks`:

```
GET    /                  ?status=&assignee=me|<uid>&limit=
POST   /                  { title, description?, priority?, assignee? }
GET    /:taskId           task + linked executions (status, pending approval) + recent activity
PATCH  /:taskId           { title?, description?, priority? }
POST   /:taskId/assign    { assignee: {type:'human', userId} | {type:'agent'} | null }
POST   /:taskId/status    { status: todo|in_progress|blocked|done|cancelled }
GET    /:taskId/activity
POST   /:taskId/comments  { body }
POST   /:taskId/execute   (Idempotency-Key supported) → Layer 3 execution linked by task_id
DELETE /:taskId           admin+, only while the task has no executions
```

Also mounted:

- `/api/workspaces/:workspaceId/permissions`: `GET` for members; `POST {resource}` and `DELETE /:grantId` for admin+.
- `/api/workspaces/:workspaceId/audit`: `GET` for admin+.

Task fields are creator, assignee (human or AI agent), status, priority, `created_at`, `updated_at` and `completed_at`, plus a version for optimistic locking. The activity trail records: `created`, `updated`, `assigned`, `status_changed`, `comment` and `execution_started`. Titles, descriptions and comments pass through `sensitiveDataFilter` before they are stored.

## 4. Role rules (existing Layer 1 roles, no new role system)

| Operation | member | admin | owner |
|---|:-:|:-:|:-:|
| View tasks, activity, evidence, executions, grants | ✓ | ✓ | ✓ |
| Create a task, comment | ✓ | ✓ | ✓ |
| Edit a task / change its status | creator or assignee | ✓ | ✓ |
| Assign to any member or the agent / unassign | own tasks | ✓ | ✓ |
| Claim an unassigned task for yourself | ✓ | ✓ | ✓ |
| Execute a task | creator or assignee | ✓ | ✓ |
| Approve a YELLOW step | creator of the execution | ✓ | ✓ |
| Approve a RED step | – | ✓ | ✓ |
| Cancel an execution | creator of the execution | ✓ | ✓ |
| Delete a task | – | ✓ | ✓ |
| Manage workspace grants | – | ✓ | ✓ |
| Read the workspace audit log | – | ✓ | ✓ |
| Chats, memory, goals | own only | own only | own only |

Chats, memory and goals are private to their creator even from admins. They belong to the workspace for isolation and deletion purposes, not for sharing.

## 5. Audit

Audit rows are written through the existing `appendAuditLog`, which now takes an optional 5th argument for `workspace_id`. Payloads are redacted, and comment bodies are never logged. The following actions are recorded:

- **Tasks:** `task_created`, `task_assigned`, `task_updated`, `task_status_changed`, `task_commented`, `task_execution_started`, `task_deleted`
- **Grants:** `workspace_grant_created`, `workspace_grant_revoked`
- **Executions (Layer 3), now attributed to a workspace:** `agent_execution_created`, `agent_execution_approval_approve` and `…_reject`, `agent_execution_cancel`, and `agent_execution_<terminal>`

## 6. Migration

`migrations/20260925_layer2_workspace_data_scoping.up.sql` is idempotent and guarded against unknown or missing tables. It does the following:

1. Ensures a personal workspace exists for every owner found in the scoped tables.
2. Adds a nullable `workspace_id` (FK `on delete cascade`) plus indexes to `chats`, `conversations`, `user_memories`, `memory_vectors`, `goals` and `goal_breakdowns`, then **back-fills** each row with its owner's personal workspace. Rows without an owner stay `NULL`; no data is invented.
3. Adds `audit_log.workspace_id` (attribution only, no FK).
4. Creates `workspace_tasks`, `workspace_task_activity` and `workspace_permission_grants` with RLS deny-by-default, and revokes privileges from `anon` and `authenticated`.
5. Adds `agent_executions.task_id` with a composite FK `(task_id, workspace_id)` → `workspace_tasks(id, workspace_id)` `ON DELETE RESTRICT`.
6. Creates `search_memories_scoped()` **only if** `memory_vectors.embedding` is a pgvector column. EXECUTE is revoked from PUBLIC, anon and authenticated, and granted to `service_role`.

**Deploy order:** migration first, then the code. Existing tables' RLS settings are intentionally not changed.

**Rollback:**

1. Deploy the previous code, or set `WORKSPACE_DATA_SCOPING=off`.
2. Run `…down.sql`.

What the rollback keeps and loses:

- **Kept:** all original rows and columns.
- **Dropped:** only the added `workspace_id`/`task_id` columns and the three new tables. Export those tables first if you need them.
- **Lost:** team attribution of chats, memory and goals. Re-running UP back-fills everything to each creator's personal workspace. The data stays visible only to its creator, but it is no longer tied to the team workspace.

## 7. Tests

```
npm test    # regression, Layer 1, pre-Layer-2 security, Layer 3, Layer 2
WORKSPACE_TEST_STORE=supabase SUPABASE_URL=… SUPABASE_KEY=<service_role of a DISPOSABLE db> \
  node __tests__/workspaceDataScoping.test.js
```

## 8. Known limitations

- **Personalisation isn't scoped.** Profiles, preferences, intelligence, digital twin, timeline, knowledge graph and behaviour analytics are still per user and are used as prompt context in every workspace the user works in. This exposes nothing to other users, but a user's context from company A can influence their prompts in company B.
- **Some readers ignore workspaces.** Cron and proactive jobs, the command-center dashboard and the data-controls export/delete read or act on all of a user's rows across workspaces. They are still limited to that user.
- **Uploaded PDFs (`pdf_vectors`) aren't scoped yet.**
- **Pre-existing auth bug on notifications.** `middleware/auth.js` treats `/notifications/:x` as a user id for every method, so `PATCH /notifications/:id/read` and `DELETE /notifications/:id` are rejected with 403 even for the owner. The route-level owner check is in place, but `auth.js` was deliberately not changed here.
- **Unscoped writes default to personal.** The voice pipeline and other unscoped writers always land in the personal workspace. Voice has no workspace concept, by design, because of the voice freeze.
- **Memory-search fallback.** If `search_memories_scoped` is missing (the embedding column isn't pgvector), team-workspace memory search fails closed and returns nothing. The personal workspace falls back to the legacy unscoped RPC.
- **Tasks don't follow executions automatically.** A task only moves to `in_progress` when it is executed. A completed execution does not mark the task done; users set that status.
- **No frontend yet.** The web app doesn't send `X-Workspace-Id` yet, so it keeps operating in the personal workspace until a workspace switcher exists.

## Layer 9 update

Status of the limitations above after Layer 9 (details: `LAYER9_LIMITATION_LEDGER.md`):

- **L2-1 — INTENTIONALLY UNSUPPORTED**: Personalisation (profile, twin, timeline, graph…) is per user, used as prompt context in every workspace → Legacy personal-assistant data is per user by design and never shown to other users.
- **L2-2 — CLOSED**: Cron/proactive jobs, command-center and data-controls read all of a user's rows across workspaces → Data export/erasure cover only the caller's OWN rows (data-subject rights), now audited (data_exported / data_deleted, counts only); secret-looking columns are redacted in exports; DB error text is no longer returned. Cron/proactive jobs read only the owner's rows (unchanged by design).
- **L2-3 — INTENTIONALLY UNSUPPORTED**: Uploaded PDFs (pdf_vectors) not workspace-scoped → pdf_vectors are private to the uploader (user_id scoped, never shared across users); workspace sharing of uploads would need pgvector RPC changes and is not an access-control gap.
- **L2-4 — CLOSED**: auth.js treats /notifications/:x as a user id for every method (PATCH/DELETE broken) → auth.js matches the user id only for GET /notifications/:userId; PATCH /:id/read and DELETE /:id are owner-checked in the route; hardening L2-4.
- **L2-5 — INTENTIONALLY UNSUPPORTED**: Unscoped writers (voice) land in the personal workspace → Voice is frozen and has no workspace concept; its writes land in the personal workspace.
- **L2-6 — INTENTIONALLY UNSUPPORTED**: Memory search fails closed without pgvector search_memories_scoped → Memory search fails closed without the pgvector RPC (safe default); documented.
- **L2-7 — INTENTIONALLY UNSUPPORTED**: Tasks do not auto-complete when an execution completes → Humans confirm task completion by design.
- **L2-8 — CLOSED**: Web app does not send X-Workspace-Id for chat/memory/goals → authFetch attaches X-Workspace-Id to /api/chat, /api/memory, /api/goals (also for callers that set Authorization themselves); a left workspace (404) is forgotten and retried in the personal one; frontend tests.
