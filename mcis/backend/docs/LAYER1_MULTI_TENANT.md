# Layer 1 — Secure Multi-Tenant Foundation

Status: implemented on 2026-09-23. Layer 2 and later are **not** started.

## What it adds

| Piece | File |
|---|---|
| Schema, backfill and RLS (up) | `migrations/20260923_layer1_workspaces.up.sql` |
| Rollback (down) | `migrations/20260923_layer1_workspaces.down.sql` |
| Business rules and authorization | `services/workspaceService.js` |
| Supabase data access | `services/workspaceStore.js` |
| Workspace context middleware | `middleware/workspaceContext.js` |
| HTTP API | `routes/workspaces.js`, mounted at `/api/workspaces` in `server.js` |
| Security tests | `__tests__/workspaces.security.test.js` (+ `__tests__/support/memoryWorkspaceStore.js`) |

Tables: `workspaces`, `workspace_members`, `workspace_invitations`. **No existing table is changed.**

## Tenancy model

- **Workspace** = tenant (organization). A user can belong to many.
- **Personal workspace**: every user has exactly one (`is_personal = true`, role `owner`). The migration creates it for every existing user it can find. If a user is missed, the backend creates it on their first `/api/workspaces` call. A partial unique index keeps this safe when two requests arrive at once. Personal workspaces can't be deleted and don't accept invitations.
- **Roles**: `owner > admin > member`.

| Action | member | admin | owner |
|---|:-:|:-:|:-:|
| View workspace and member list | ✓ | ✓ | ✓ |
| Leave the workspace (remove self) | ✓ | ✓ | – (owner can't leave) |
| Rename the workspace | | ✓ | ✓ |
| List, create or revoke invitations for the `member` role | | ✓ | ✓ |
| Invite someone as `admin` | | | ✓ |
| Remove a member | | ✓ | ✓ |
| Remove an admin | | | ✓ |
| Change a member's role (admin ↔ member) | | | ✓ |
| Delete the workspace (team workspaces only) | | | ✓ |

The owner role can't be changed or removed. Ownership transfer is not part of Layer 1.

## Isolation guarantees (enforced and tested)

1. `resolveContext()` is the only place a client-supplied workspace ID is turned into a context. It requires a `workspace_members` row for the verified Firebase uid.
2. A non-member, an unknown ID or a malformed ID all get the same `404`, so workspace IDs can't be probed.
3. Member and invitation sub-resources are checked again against the resolved workspace. You can't reach workspace A's invitation or member through workspace B's URL.
4. The workspace routes require a verified `req.user`. The existing development bypass in `middleware/auth.js` (missing Firebase credentials, or `ALLOW_UNAUTHENTICATED_API=true`) does **not** open them. They return `401`.
5. Invitations:
   - The token is 256 random bits. Only its SHA-256 hash is stored, and the raw token is returned once.
   - Tokens are single-use: a compare-and-set on `status` means only one of several concurrent accepts can succeed.
   - Tokens expire after 7 days and can be revoked.
   - The accepting account's email must match the invited email.
   - The email must be verified by default. Set `WORKSPACE_INVITES_REQUIRE_VERIFIED_EMAIL=false` to allow unverified emails (see Limitations).
6. Database: RLS is enabled with **no policies**, and the `anon` and `authenticated` roles have their privileges revoked. Only the `service_role` key (which bypasses RLS) can read or write these tables.
7. Role changes take effect on the next request because nothing is cached.

## API (all under `/api/workspaces`, Firebase bearer token required)

```
GET    /                                   my workspaces (+ role); creates personal if missing
POST   /                        {name}     create team workspace → 201
GET    /current                            workspace from X-Workspace-Id header, else personal
POST   /invitations/accept      {token}
GET    /:workspaceId
PATCH  /:workspaceId            {name}
DELETE /:workspaceId
GET    /:workspaceId/members
PATCH  /:workspaceId/members/:userId   {role: admin|member}
DELETE /:workspaceId/members/:userId   (self = leave)
GET    /:workspaceId/invitations
POST   /:workspaceId/invitations       {email, role?}   → 201 {invitation, token}
DELETE /:workspaceId/invitations/:invitationId
```

Responses look like `{ success, data }` or `{ success: false, error, code }`.

No email is sent. The inviter receives the token once and shares it (for example as a link to the frontend). Adding an email provider is outside Layer 1.

### Reusing the middleware in future (Layer 2+) routes

```js
const { workspaceContext, requireWorkspaceRole } = require('../middleware/workspaceContext');
router.get('/something', workspaceContext(service), requireWorkspaceRole('member'), (req, res) => {
  // req.workspace = { id, role, workspace, userId }; scope every query by req.workspace.id
});
```

This middleware costs one or two DB round trips per request. **Don't** add it to `/api/command`, `/api/voice`, the agent socket or other voice and automation hot paths unless you first add a short-TTL membership cache.

## Deployment prerequisites

- `SUPABASE_KEY` must be the **service_role** key. With the anon key, the new tables return "permission denied" because of the deny-by-default RLS, and the endpoints return 500. Existing features are unaffected either way.
- Firebase Admin credentials must be configured. Without them, the workspace endpoints return 401 by design.

## Migration

1. Back up (Supabase → Database → Backups, or `pg_dump`).
2. Open the Supabase SQL editor and run `migrations/20260923_layer1_workspaces.up.sql`. It's idempotent, so running it again is harmless.
3. Verify:
   ```sql
   select count(*) filter (where is_personal) as personal, count(*) from public.workspaces;
   select owner_id, count(*) from public.workspaces where is_personal group by 1 having count(*) > 1; -- expect 0 rows
   ```
4. Deploy the backend.

**Backfill scope.** The migration collects user IDs from these tables when they exist and have a `user_id` column: `chats, conversations, user_memories, user_profiles, user_preferences, goals, notifications, device_tokens, user_permissions, daily_usage, audit_log, events`. Any user it misses gets a personal workspace on their first call.

## Rollback

1. Roll back the code first: remove the two `workspacesRoute` lines in `server.js`, or redeploy the previous build.
2. Optionally export the three tables (the commands are in the down file).
3. Run `migrations/20260923_layer1_workspaces.down.sql`. It drops only the three Layer 1 tables, and no pre-Layer-1 data is affected.

## Tests

```bash
cd mcis/backend
npm test     # existing regression suite + Layer 1 security suite (in-memory store)
```

**Against a real database** (disposable local Postgres and PostgREST only, **never** production):

```bash
SUPABASE_URL=http://127.0.0.1:54331 SUPABASE_KEY=<local service_role JWT> \
WORKSPACE_TEST_STORE=supabase node __tests__/workspaces.security.test.js
```

## Limitations (Layer 1 scope)

- Existing data (chats, memories, goals, devices, permissions, audit log, and so on) is still **scoped per user, not per workspace**. The user-ID guard in `middleware/auth.js` still protects it. Moving that data under `workspace_id` is later-layer work.
- The frontend has no workspace UI yet. The API is backend-only.
- There's no ownership transfer and no email delivery for invitations.
- By default, email/password users must verify their email before accepting invites. The current frontend doesn't send verification emails.
- There's no rate limit on invite acceptance. A 256-bit token makes guessing impractical, but a limiter is cheap to add later.

## Layer 9 update

Status of the limitations above after Layer 9 (details: `LAYER9_LIMITATION_LEDGER.md`):

- **L1-1 — CLOSED**: Existing legacy data is per user, not per workspace → Obsolete: Layer 2 scoped chats/memory/goals; the rest is L2-1/L2-2.
- **L1-2 — CLOSED**: No frontend workspace UI → Obsolete: workspace switcher on every Layer 4/8 page and /workspace.
- **L1-3 — CLOSED**: No ownership transfer → POST /api/workspaces/:id/transfer-ownership {newOwnerId}; RPC transfer_workspace_ownership (one transaction); UI in Workspace → Team; hardening L1-3 (memory + Postgres).
- **L1-4 — REMAINING**: No email delivery for invitations → Invitations are shared as one-time codes. Emailing them needs an email provider and a verified sending domain that this project does not have; nothing was faked. Exact step: pick a provider, add an invitation mailer that sends the existing one-time link.
- **L1-5 — CLOSED**: Frontend does not send verification emails although invites require a verified email → Auth.js sends the Firebase verification email on sign-up; Workspace → Team offers "Send verification email"; frontend tests.
- **L1-6 — CLOSED**: No rate limit on invite acceptance → DB-backed limiter: 20 acceptances / 10 min per user → 429; hardening L1-6.
