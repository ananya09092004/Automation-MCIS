# Layer 5 — Integrations, Credentials & Connectors

Status: implemented 2026-09-24. Off by default. Requires Layers 1–4.

```
Workspace → Integration → Encrypted credential → Connector → Permission + risk policy
         → Layer 3 execution (approvals, evidence) → Layer 4 workflow run → Evidence + audit
```

## 1. Configuration

| Variable | Required | Meaning |
|---|---|---|
| `INTEGRATIONS_ENABLED` | – | `true` mounts `/api/workspaces/:ws/integrations` and attaches the connector gateway. **Any other value, or unset, means disabled.** Layers 1–4 and workflows without connector steps keep working either way. |
| `INTEGRATION_ENCRYPTION_KEY` | yes, when enabled | 32 random bytes, base64 (44 characters) or hex (64). Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. **There is no fallback:** when it is missing or invalid, every credential operation returns 503 `CREDENTIALS_UNAVAILABLE` and nothing is stored. |
| `INTEGRATION_ENCRYPTION_KEY_ID` | – | Label stored with each ciphertext. Default `k1`. |
| `INTEGRATION_ENCRYPTION_OLD_KEYS` | – | `id:key,id:key`. Retired keys stay readable during a rotation; new writes always use the current key. |

Store the key in your host's secret store (Render/Vercel environment settings), never in the repo. If you lose the key, the stored credentials can't be recovered; admins then re-enter the tokens.

Deployment order:
1. Apply `migrations/20260927_layer5_integrations.up.sql`.
2. Set `INTEGRATION_ENCRYPTION_KEY`.
3. Set `INTEGRATIONS_ENABLED=true`.

Rollback: unset the flag, then run `…down.sql`. The down migration deletes the three integration tables only.

## 2. Data model

| Table | Holds | Constraints |
|---|---|---|
| `integrations` | provider, display name, status (`disconnected \| connected \| revoked \| error`), **non-secret** config, `created_by`, `last_used_at`, `last_checked_at`, redacted `last_error`, version | `unique (workspace_id, lower(name))`, `unique (id, workspace_id)` |
| `integration_credentials` | **AES-256-GCM ciphertext only**: `key_id`, `iv`, `auth_tag`, `ciphertext` | one row per integration; composite FK to the integration **in the same workspace** |
| `integration_permissions` | per action: `enabled`, `approval` (`default \| required \| admin`), `min_role` | PK `(integration_id, action)`; composite FK in the same workspace |

Row-level security is deny-by-default on all three tables, and `anon` and `authenticated` have no privileges.

## 3. Credential service (`services/integrations/credentialService.js`)

This is the only code that sees plaintext.

- **Functions:** `encrypt`, `decrypt`, `storeCredential`, `getCredentialForExecution`, `deleteCredential`.
- **Encryption:** each write gets a random 96-bit IV and is authenticated with GCM.
- **Binding:** the AAD is `nexus-integration:<workspace>:<integration>`, so a ciphertext copied onto another integration or workspace can't be decrypted.
- **Where plaintext exists:** decryption happens only inside the gateway's `executeAction` and `healthCheck`, immediately before the connector call.
- **Scrubbing:** every value the connector returns is scrubbed of the secret strings before it goes anywhere, as a guard against providers that echo tokens back.
- **Future secret manager:** the service sits behind a small store interface, so it can later move to an external secret manager without touching connectors.

## 4. Connectors (`services/integrations/connectors/`, `connectorRegistry.js`)

**Contract.** Every connector provides:
- `provider`, `actions`
- `validateConfig`, `validateCredential`, `requiresCredential`
- `connect`, `disconnect`, `healthCheck`, `validateAction`, `describeTarget`, `execute`, `redactResult`

**Action descriptors.** Each action declares:
- label and permission name
- **risk** (GREEN, YELLOW or RED)
- `readOnly`, `safeToRepeat(config)`, `defaultEnabled`
- input schema, output shape, timeout and retry policy

Connectors never touch the database: they receive the decrypted credential as an argument.

### HTTP / REST API (`http`)

- One HTTPS base URL per integration, plus an optional host allowlist and path prefixes.
- Auth type is `none`, `bearer` or a custom header.

| Action | Risk | Default | Retry |
|---|---|---|---|
| `get` (path + query under the allowed prefixes) | GREEN | enabled | safe |
| `post_json` (only if `allowPost`; path under `postPathPrefixes`) | YELLOW | disabled | only if `idempotencyHeader` is configured; the key is stable per workflow step (`wfstep:<run>:<pos>`) |

There is no PUT, PATCH or DELETE.

### GitHub (`github`)

- REST API version 2022-11-28, authenticated with a PAT.
- Access is limited to the admin-configured `allowedRepos` (`owner/repo` or `owner/*`).

| Action | Risk | Default | Retry |
|---|---|---|---|
| `get_repository`, `list_issues` (pull requests filtered out), `list_pull_requests`, `read_file` (≤100 KB, base64-decoded) | GREEN | enabled | safe |
| `create_issue`, `comment_on_issue` | YELLOW | **disabled** | never (GitHub offers no idempotency keys) |

Merge, close, delete and push are deliberately not implemented. Health checks call `GET /user`. A 401 from GitHub marks the integration **revoked**, using a compare-and-set so a concurrent token rotation always wins.

### Google Drive — not implemented (blocker)

- The repo has no Drive support.
- The only Google code is an in-memory Calendar OAuth stub.
- No OAuth client is configured.
- A real Drive connector needs a registered Google OAuth client (with `drive.file` scope and a consent screen) or a service account, plus live testing.

It was not built, rather than shipping untested OAuth.

## 5. SSRF protection (`services/integrations/safeHttp.js`)

Every connector call, on every hop, requires:

- **Scheme:** https.
- **URL shape:** no userinfo; the default port only.
- **Host:** on the integration's allowlist, and not an internal name (localhost, `*.local`, `*.internal`, metadata names, single-label hosts).
- **Every resolved address public.** Blocked:
  - loopback
  - RFC1918 private ranges
  - CGNAT
  - link-local and 169.254.169.254
  - multicast and reserved ranges
  - IPv6 ULA and link-local
  - IPv4-mapped, NAT64 and 6to4 forms of any of the above
- **Pinned lookup:** the socket connects to the address that was validated, so DNS rebinding is impossible.
- **Redirects:** followed manually, GET only, max 3, each hop re-validated; credential headers are dropped when the host changes.
- **Limits:** a hard deadline, a byte limit (declared and streamed) and a content-type allowlist.

Errors return a code and a message we wrote, never provider bodies or headers.

## 6. Permissions, risk and approvals (reuses Layer 3)

**Effective tier** is the highest of:
1. the action's declared risk
2. the admin's per-action approval setting (`required` means YELLOW, `admin` means RED)
3. the workflow step's approval policy

YELLOW and RED go through the **existing** Layer 3 approval gate:
- YELLOW: the initiator or an admin approves
- RED: an admin approves
- approvals are single-use, expire, and are rejected when stale

**Other checks:**
- **Minimum role:** checked against the initiator's *current* membership at execution time.
- **Workspace grants:** with `PERMISSIONS_ENFORCED=true`, the resource `integration:<id>` needs a workspace grant (the Layer 2 grants table).

**Checked again when the action runs,** not only at submission: the integration exists in the workspace, it is connected, the action is enabled, the role is sufficient, and the input is valid.

**Layer 3 hook (additive).** `createExecution({ connectorStep: { integrationId, action, input } })` runs ONE deterministic action through the normal lifecycle:
- no planner and no LLM, so credentials can never reach a prompt
- same approvals, in-flight marker, evidence, verification, cancel and timeout
- a failed connector step stops immediately rather than looping
- reads are retried once only on transient errors; writes are never retried

The planner path was only re-indented; a whitespace-insensitive diff shows 4 changed lines.

## 7. Workflows (Layer 4, additive)

A step can include `connector: { integrationId, action, input }`, where input values are strings (templates allowed), numbers or booleans. Such steps:

- **At publish time:** must reference an integration **of the same workspace** and an action its provider actually has. With integrations disabled, publish returns 409 `INTEGRATIONS_DISABLED`.
- **At runtime:** templates render from redacted inputs and earlier outputs. A disconnected or revoked integration fails the step with `INTEGRATION_UNAVAILABLE` ("… is disconnected; an admin must reconnect it") and **no provider call is made**.
- **Recovery:** read-only connector actions count as safe to repeat; anything else interrupted or failed pauses the run as `needs_review`, never re-sent.

## 8. API (`/api/workspaces/:ws/integrations`)

| Method | Path | Role |
|---|---|---|
| GET | `/providers` | member+ |
| GET | `/` | member+ |
| POST | `/` (connect) | admin+ |
| GET | `/:id` | member+ |
| PATCH | `/:id` (version required) | admin+ |
| POST | `/:id/credentials` (rotate) | admin+ |
| POST | `/:id/disconnect` (deletes the ciphertext) | admin+ |
| POST | `/:id/reconnect` (no-credential APIs) | admin+ |
| POST | `/:id/health` | admin+ |
| PUT | `/:id/permissions` | admin+ |

- Responses are `Cache-Control: no-store` and never contain credentials; they show only `hasCredential`, `credentialUpdatedAt` and effective permissions.
- A non-member, and a foreign id inside your workspace, both get the same 404.

**Audit events:**
- `integration_connected`, `integration_updated`, `integration_credential_rotated`, `integration_disconnected`, `integration_health_checked`, `integration_permissions_changed`
- `connector_executed`, including failures with a code
- Layer 3's `agent_execution_approval_*`

Each event carries workspace, actor, provider, action, result and timestamp, and never secrets.

## 9. Frontend

- **`/integrations`:** workspace switcher, connected list with status, health and permissions, available providers, connect, rotate, disconnect, health check, and per-action enable/approval for admins.
- **Token fields** are uncontrolled password inputs, read through a ref only at submit time and cleared immediately. They are never React state or localStorage.
- **Workflow editor:** a step can pick Integration → Action (labelled like "GitHub — Read repository"; disabled actions are greyed out) → inputs.

## 10. Known limitations

- **GitHub** is verified live against api.github.com only for **unauthenticated public reads**. Authenticated reads, writes and health checks were tested against a local API double, not the real GitHub API, because no token was available.
- **Google Drive:** see §4.
- **HTTP connector:**
  - no OAuth and no query-string auth
  - `POST` bodies are limited to JSON objects of 16 KB or less
  - only JSON and text responses are parsed
- **Credential rotation** is a manual replace. There's no automated key re-encryption job; old keys stay readable through `INTEGRATION_ENCRYPTION_OLD_KEYS`.
- **The legacy per-user GitHub OAuth** (`services/githubService.js`, table `user_integrations`) still stores tokens in plaintext and uses a guessable OAuth `state`. It is untouched here, but should be migrated onto this credential service or removed.


## Layer 6 update

- The gateway only executes a connector action with a single-use Agent
  Firewall ticket bound to workspace + actor + integration + action + input
  (`FIREWALL_BYPASS_BLOCKED` otherwise) when the firewall is enabled.
- GitHub integrations may carry `config.authMethod` (`token`|`oauth`) and
  `config.account`; per-user GitHub OAuth (legacy `/api/github/*`) now stores
  its token here, encrypted. SSRF blocks are recorded as `security.ssrf_blocked`.
See `docs/LAYER6_SECURITY.md`.

## Layer 9 update

Status of the limitations above after Layer 9 (details: `LAYER9_LIMITATION_LEDGER.md`):

- **L5-1 — EXTERNAL VALIDATION**: GitHub authenticated reads/writes not tested against real GitHub → GitHub reads/writes are tested against a local GitHub API double only. External step: connect a real repository with a fine-grained PAT and run list_issues/read_file/create_issue once.
- **L5-2 — EXTERNAL VALIDATION**: Google Drive not implemented → Read-only Google Drive connector (list_files, get_file, read_text) through the gateway + firewall, folder allowlist, token refresh, workspace OAuth connect — tested against a local Drive/Google-token double. External step: create a Google OAuth client, set GOOGLE_DRIVE_ENABLED + GOOGLE_OAUTH_*, connect a test Google account, run the three actions (Google app verification is needed for external users).
- **L5-3 — CLOSED**: HTTP connector: no query-string auth → HTTP connector authType "query" (authQueryParam); key never in evidence/audit/logs; clients cannot set that parameter; redirects not followed; hardening L5-3.
- **L5-4 — INTENTIONALLY UNSUPPORTED**: HTTP connector: POST bodies JSON ≤16 KB → POST bodies are JSON ≤16 KB by design.
- **L5-5 — INTENTIONALLY UNSUPPORTED**: HTTP connector: only JSON/text responses parsed → Binary responses are not fed to the agent by design.
- **L5-6 — CLOSED**: Credential rotation manual; no re-encryption job → scripts/rotate-integration-keys.js re-encrypts every credential under the current key (CAS, dry run, counts only); tested memory + Postgres incl. concurrent runs.
- **L5-7 — CLOSED**: Legacy GitHub OAuth plaintext tokens + guessable state → Obsolete: Layer 6 moved legacy GitHub tokens into the encrypted store.
