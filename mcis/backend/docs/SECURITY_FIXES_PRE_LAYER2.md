# Security fixes before Layer 2 (2026-09-23)

These are fixes for the four issues from the pre-Layer-2 audit, plus the two goal endpoints found during that audit. Layer 1 code is unchanged.

## What changed

| # | Issue | Fix |
|---|---|---|
| 4 | `npm ci` failed on npm 10 because the lockfile was generated with npm 11 | Regenerated `package-lock.json` with npm 10. It only **adds** 3 entries under `mongoose/node_modules` (`gaxios`, `gcp-metadata`, `node-fetch`), which are optional peer dependencies of mongodb that the app never loads. No other entry changed. |
| 2 | `POST /api/permissions/grant` had no auth, stored grants under a hardcoded `test-user-123`, and resumed any plan | The route now requires a caller. Grants are stored under the real caller ID. Plan resume requires that the caller owns the plan (otherwise **404**) and that the plan is `paused` (otherwise **409**). |
| 3 | `POST /api/emergency/stop` and `/resume` had no auth | Both routes now require a caller. The stop is still process-wide, as before. |
| — | `GET /api/command/goal/:planId/status` and `POST …/answer` had the same flaw: no auth and no ownership check, and `answer` logged under `body.userId \|\| 'test-user-123'` | Both routes now require a caller and only work on the caller's own plan (otherwise 404). `answer` logs under the resolved caller. |
| — | Plan IDs came from `Math.random()` (about 41 bits, predictable) | Plan IDs are now `'plan_' + crypto.randomBytes(16).toString('hex')` (128 bits). |
| 1 | `isPermitted()` was hard-coded to `return true` | It now checks an explicit `PERMISSIONS_ENFORCED` switch (see below). |

### Caller resolution
The logic lives in `security-engine/callerIdentity.js`. It was moved unchanged out of `commandRoute.js`, so `/api/command` behaves exactly as before. The resolution order is:

1. The `X-Device-Token` header matches `NEXUS_VOICE_DEVICE_TOKEN`. The caller becomes `voice-device:<deviceId>`. No network call is made.
2. A Firebase ID token.
3. A paired-device token from `device_tokens`.
4. The development bypass (`test-user-123`), but **only** when `NODE_ENV !== 'production'` and `ALLOW_UNAUTHENTICATED_API=true`.

These routes stay in `middleware/auth.js` `publicApiPaths`, which exempts them from the Firebase-only middleware. They are **not** public: each one authenticates the caller itself using the order above.

### Voice-device principal
All holders of `NEXUS_VOICE_DEVICE_TOKEN` count as one principal (`isSamePrincipal`), and permission grants for them are stored under `voice-device`. The `deviceId` suffix is supplied by the client and not authenticated. The voice client also omits it on grant, status and answer calls. So a plan started as `voice-device:LAPTOP-1` can be polled and approved by the same voice client.

## `PERMISSIONS_ENFORCED`

| Value | Behaviour |
|---|---|
| unset / anything except `true` (**default**) | Same as before: every resource is permitted, and no database lookup is made. RED actions are still blocked by the risk model. When `NODE_ENV=production`, the server logs `SECURITY WARNING: PERMISSIONS_ENFORCED …` at boot. |
| `true` | Resources outside `SAFE_LIST` need a `user_permissions` row for the caller. A database error denies the action (fails closed). |

**Before enabling it for voice users:** after the user approves a first-time resource, the voice client does not re-send the original command, so the user has to say it again. Each allowed action also costs one extra Supabase round trip. Both are follow-up work.

## Deployment notes
- The voice client must send `X-Device-Token`, and the backend must have the same `NEXUS_VOICE_DEVICE_TOKEN`. `/api/command` already required this in production. Without it, the Ctrl+M / Ctrl+N emergency stop and resume calls now return 401. The voice client prints the error and does not crash.
- Existing `user_permissions` rows stored under `test-user-123` are no longer matched by any real caller. They were never tied to a real user.
- Plans live in memory. Deploying this change restarts the process, so any in-flight plans are lost, as with any deploy.

## Tests
`npm test` runs these suites:

| Suite | Tests |
|---|---|
| `backend-routing/__tests__/regression.test.js` | 15 |
| `__tests__/workspaces.security.test.js` (Layer 1) | 44 |
| `__tests__/voiceSurface.security.test.js` (these fixes) | 27 |

## Remaining limitations (not changed here)
- Emergency stop is global: any authenticated caller can stop or resume automation for everyone on this server instance. Scoping it per user or workspace belongs in a later layer.
- Resuming an approved plan re-asks the planner instead of executing the approved `pendingStep`. This is existing planner behaviour; the planner may propose the same RED step and pause again.
- In `/api/command`, RED actions always return 403, even after a grant. This is existing behaviour.
- `taskPlanner.resumePlan()` (synchronous, exported but never called or routed) has no ownership check. It is unreachable over HTTP.
