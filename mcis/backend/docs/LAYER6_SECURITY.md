# Layer 6 — Enterprise Security + Agent Firewall

Layer 6 adds a workspace security policy, ONE central decision point in
front of every agent tool / connector action (the Agent Firewall), a
sensitive-data firewall, workspace API keys, a single-use OAuth state
service (and the migration of legacy GitHub OAuth to encrypted storage),
typed structured step outputs, multi-instance safety (execution leases,
fenced durable jobs), hardened approvals, security events and a `/security`
dashboard.

It is additive: Layers 1–5 keep working; Layer 3's approval gate is still the
ONLY approval mechanism; nothing in the voice system was changed.

## 1. Architecture

```
request ──► Firebase auth ─► Layer 1 workspaceContext (membership, role)
                                   │
   Layer 4 runner / Layer 3 API ──►│ Layer 3 executionService (one step at a time)
                                   │   plan step ──► AGENT FIREWALL (phase=plan)
                                   │                   DENY → evidence POLICY_DENIED, execution failed
                                   │                   APPROVAL_REQUIRED → Layer 3 approval (tier raised)
                                   │   [human approves — binding re-checked]
                                   │   execute ──► AGENT FIREWALL (phase=execute, fresh policy + role)
                                   │                   stricter now → POLICY_DENIED / STALE_APPROVAL
                                   │                   connector → single-use ticket
                                   ▼
           Nexus bridge (browser/desktop/file)     Layer 5 gateway — requires the ticket
```

Files (backend):

| File | Role |
|---|---|
| `services/security/policyEngine.js` | policy schema, secure defaults, pure `decide()` |
| `services/security/agentFirewall.js` | `evaluateAgentAction()`, tickets, fail-closed, throttles |
| `services/security/sensitiveClassifier.js` | secret detection/sanitization, injection signals |
| `services/security/securityEvents.js` | `security.*` audit events, DB + in-process rate limiters |
| `services/security/securityStore.js` | Supabase persistence (policies, keys, OAuth states, limits, events) |
| `services/security/apiKeyService.js` | workspace API keys |
| `services/security/oauthStateService.js` | reusable OAuth state |
| `services/security/githubOAuth.js` | GitHub OAuth over the SSRF-safe client, encrypted storage |
| `services/security/securityService.js` | policy management, events, dashboard |
| `routes/security.js` | `/api/workspaces/:ws/security/*` + production wiring + flag |
| `routes/automation.js` | `/api/automation/v1/*` (API-key auth) |
| `scripts/migrate-legacy-github-tokens.js` | one-time plaintext → encrypted migration |
| `migrations/20260928_layer6_security.{up,down}.sql` | schema |

## 2. Policy engine

One policy document per workspace (`workspace_security_policies`, versioned,
compare-and-set). No row = built-in secure default. The policy is only read
from the database by workspace id; nothing a client sends is treated as policy.
Stored policies are re-validated on every read; an invalid one makes the
firewall deny everything.

```json
{
  "maxRisk": "red",
  "executionTypes": { "connector": true, "browser": true, "desktop": true },
  "integrations": { "allowProviders": null, "denyIntegrationIds": [] },
  "connectorActions": { "github.create_issue": "admin_approval", "http.*": "approval", "*": "allow" },
  "agentActions": { "run_terminal": "admin_approval" },
  "domains": { "allow": [], "deny": ["*.evil.example"] },
  "repositories": { "allow": ["acme/*"], "deny": [] },
  "files": { "read": "allow", "write": "approval", "delete": "deny", "protectedPaths": ["c:/finance"], "roots": ["c:/work"] },
  "sensitiveData": { "blockSecretsInInput": true },
  "approval": { "ttlMinutes": 15, "taintedRequiresApproval": true },
  "minRole": { "execute": "member", "stateChanging": "member" },
  "schedule": { "daysUtc": [1,2,3,4,5], "startHourUtc": 6, "endHourUtc": 20 }
}
```

Rules: `allow` | `approval` (YELLOW) | `admin_approval` (RED, admin+ approves) | `deny`.
The effective decision is the MOST RESTRICTIVE of every rule that applies;
rules can only keep or raise the tier computed by Layer 3 (riskModel) and
Layer 5 (per-action permission). Unknown fields are rejected.

Built in, not relaxable: credential extraction (ssh keys, cloud credential
files, `.env`, `.pem/.key/.p12`, browser cookie / login stores, keychains,
`.git-credentials`, `.netrc`, `.npmrc` …) is denied for any file read, write,
copy or upload and for connector file reads; resources naming another
workspace are denied; relative path traversal is denied; cloud metadata
endpoints are denied; tainted executions need approval for non-read actions.

Denied by default, relaxable only explicitly (and then always admin-approval):
`run_terminal, kill_process, start_process, restart_process, install_software,
save_session, load_session`; file deletes (`files.delete`, default `deny`).

## 3. Agent Firewall decision flow

`evaluateAgentAction({ workspaceId, actorId, executionId, workflowRunId,
integrationId, provider, action, executionType, baseRisk, readOnly, resource,
input, tainted, roleCap, phase, approved })` →
`{ decision: ALLOW | APPROVAL_REQUIRED | DENY, risk, reasons, policyId,
policyVersion, requiredRole, approvalTtlMinutes, ticket? }`

1. Load policy (plan phase: ≤5 s cache; execute phase: always fresh) and the
   actor's CURRENT role from membership (API-key actors capped at member).
   Any failure → `DENY POLICY_UNAVAILABLE` (fail closed).
2. Classify the input (context + shape) → `inputSecretKinds`.
3. `policyEngine.decide()`.
4. Throttle: an actor with > 10 denials in 5 minutes gets
   `SUSPICIOUS_ACTIVITY_THROTTLED` for state-changing actions (reads still work);
   connector executions are limited per workspace (120/min).
5. Execute phase: APPROVAL_REQUIRED without a Layer 3 approval → DENY; allowed
   connector actions get a 60-second, single-use HMAC ticket bound to
   workspace + actor + integration + action + exact input. The Layer 5
   gateway refuses to run without it (`FIREWALL_BYPASS_BLOCKED`).
6. Events: `policy_allow` (execute phase), `policy_deny`, `connector_blocked`,
   `credential_access_denied`, `sensitive_data_blocked`, `rate_limited`,
   `suspicious_activity`.

## 4. OAuth migration (legacy GitHub)

Before: `state = base64(userId)` (guessable, replayable, forgeable) and the
access token stored in plaintext in `user_integrations.github_token`.
`POST /api/github/push` took the target user from the request body.

Now:
- State: `u.`/`w.` + 32 random bytes; only SHA-256 stored in `oauth_states`
  with user, workspace, provider, purpose and a 10-minute expiry; consumed
  atomically (`consume_oauth_state`) → single use across instances; wrong
  user / workspace / provider / purpose, malformed, expired and reused states
  are rejected with ONE generic error (reason only in security events).
- Token: exchanged through the SSRF-safe client, stored AES-256-GCM in the
  Layer 5 credential store as the "GitHub account (OAuth)" integration of the
  user's personal workspace. Nothing reads or writes `github_token` any more
  (`githubService`, `githubRepoReader`, routes). One GitHub credential system.
- DB: a trigger on `user_integrations` rejects any new non-null `github_token`.
- Existing rows: `node scripts/migrate-legacy-github-tokens.js [--dry-run]`
  encrypts them and nulls the column; rows that cannot be migrated are still
  cleared (the user reconnects). Output is counts only.
- Callback errors redirect to `/settings?github=error` with no detail;
  usernames are URL-encoded; `/push` acts only for the caller; repo/file paths
  are validated and encoded (no `../` into other API endpoints).
- Workspace connections (owner): `POST /security/oauth/github/start`; the
  public callback hands code+state to the frontend in the URL FRAGMENT; the
  frontend POSTs them to `/security/oauth/github/complete` where the caller
  must be the user and workspace the state was issued for.

## 5. API keys

`nxk_<12-char prefix>_<43-char secret>`; SHA-256 only at rest; plaintext
returned once (create/rotate). Owner: create / revoke / rotate; admin: list
metadata. Optional expiry (1–365 days), scopes (`workflows:run`, `runs:read`),
workflow allowlist, `last_used_at`. A key resolves to its workspace with
MEMBER rights and its creator as actor; it stops working when the creator is
no longer the owner. Keys are accepted only by `/api/automation/v1` (Bearer or
`X-Api-Key`; keys in URLs → 400), cannot decide approvals, and pass through
workflow authorization, the firewall (role cap), Layer 3 approvals and audit.
Limits: 60 requests/min per key (DB), 30 failed auths / 5 min per IP (per
instance, pre-auth).

## 6. Structured outputs

```json
{ "key": "repo", "connector": { … }, "outputs": [{ "name": "open_issues_count", "type": "number" }] }
```
Types: string, number, boolean, object, array; ≤ 10 per step; agent steps may
only declare `{ name: "summary", type: "string" }`. Referenced as
`{{steps.<key>.outputs.<name>}}` (validated at save/publish). Before a later
step can see them the runner validates: required present, exact type, finite
numbers, no `__proto__`/`constructor`/`prototype` keys, ≤ 16 KB, secrets
redacted. Invalid → step fails `OUTPUT_INVALID` (not retried). Rendering is
still one pass (a value containing `{{…}}` stays literal); a connector input
that is exactly one number/boolean output keeps its type. Outputs showing
injection signals are marked `tainted`; later steps that reference them run
tainted.

## 7. Multi-instance safety

- Layer 4 jobs: `claim_workflow_job_v2` increments `lease_fence`; heartbeat and
  release (`_v2`) require owner AND fence; the runner re-checks owner+fence
  before starting an attempt and before settling a step (`worker_fenced` event).
  A stale driver — even one with the same worker id — cannot write a decision.
- Layer 3 executions: optional ownership lease (`options.leaseMs`; the
  production service uses 30 s unless `MULTI_INSTANCE_EXECUTION=false`),
  renewed every leaseMs/3. Other instances leave a leased execution alone,
  may decide its approval (DB compare-and-set; the owner applies it on its
  next heartbeat, the raw step never leaves the owner), and only fail it as
  `SERVER_RESTART` after the lease expired (`execution_recovered` event).
- What is still in memory (honestly): the raw planner context and the pending
  step of an execution live only in the owning process. If that process dies
  the execution is failed, never resumed elsewhere; a workflow step whose
  in-flight action was not read-only pauses as `needs_review`.

## 8. Sensitive-data boundary

`sensitiveClassifier` = existing `sensitiveDataFilter` + connection strings
(`scheme://user:pass@`, `Password=`), cookie headers, context keys (password,
token, cookie, authorization, client secret, connection string …), provider
key shapes (incl. `nxk_` keys) and a conservative high-entropy detector.
It now backs every persisted/returned value in Layers 2–5 (execution goals,
evidence, approvals, task activity, workflow inputs/outputs, connector
results, audit, security events). With the firewall on, the planner LLM only
sees a sanitized goal and tool output wrapped as `untrusted_external_data`.
Connector writes whose input contains a secret are denied.

## 9. Prompt / tool injection

External content is data: tool/connector output never feeds policy, roles,
approvals, credential or integration selection, or the workspace — those
come only from the server (policy table, membership, workflow definition,
URL). Injection phrases in tool output taint the execution (audited as
`suspicious_tool_injection`); tainted executions need a human approval for
anything that is not read-only.

## 10. Approval hardening

Each approval stores `binding_hash = sha256(workspace | execution |
workflow run/version/position | step index | action | step payload hash |
risk | policy version)` and `policy_version`. On decision: current membership
role, single pending approval, expiry, CAS, binding and policy version are
re-checked; any mismatch → `STALE_APPROVAL` (execution failed). API keys cannot
approve. Approval TTL = min(Layer 3 default, policy `approval.ttlMinutes`).
10 failed decisions / 5 min per user → 429. After approval, the execute-time
firewall check stops the step if the decision became stricter.

## 11. Security events

Audit rows `security.<type>` in the workspace-scoped `audit_log`, payloads
sanitized: policy_allow/deny/updated, approval_requested/granted/rejected/
rejected_stale, connector_blocked, api_key_created/revoked/rotated/
auth_failed, oauth_state_rejected, oauth_connected, credential_access_denied,
ssrf_blocked, sensitive_data_blocked, suspicious_tool_injection,
suspicious_activity, rate_limited, worker_fenced, execution_recovered,
structured_output_rejected.

## 12. Roles

| | owner | admin | member | API key |
|---|---|---|---|---|
| change policy, API keys, OAuth connect | ✓ | – | – | – |
| view dashboard / policy / events / key metadata | ✓ | ✓ | – | – |
| integrations, connector permissions (Layer 5) | ✓ | ✓ | – | – |
| approve RED | ✓ | ✓ | – | never |
| run permitted tools | ✓ | ✓ | ✓ | member rights |

## 13. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SECURITY_FIREWALL_ENABLED` | `true` | `false` turns off the firewall only (Layer 3 approvals, API-key hashing, OAuth state, encrypted GitHub storage stay). Any other value → error logged, firewall ON. |
| `MULTI_INSTANCE_EXECUTION` | on | `false` = Layer 3 single-instance behaviour (no execution lease) |
| `INTEGRATION_ENCRYPTION_KEY` (+ `_KEY_ID`, `_OLD_KEYS`) | – | required for any credential incl. GitHub OAuth (503 otherwise) |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_REDIRECT_URI` | – | GitHub OAuth app (503 if missing) |
| `FRONTEND_URL` | `http://localhost:3000` | OAuth callback redirects |

Deployment order: apply `20260928_layer6_security.up.sql` → run
`scripts/migrate-legacy-github-tokens.js` → deploy code. Rollback: code first,
then the down migration (migrated tokens stay encrypted).

## 14. Rate limits and multi-instance notes

DB-backed (`security_rate_limit_hit`, atomic fixed windows, shared by all
instances): per API key, OAuth starts per user (20/10 min), connector
executions per workspace, denials per actor, failed approvals per user.
In-process only: failed API-key authentications per IP (so an unauthenticated
flood never writes to the DB) — with N instances the effective limit is N×.
The firewall's 5-second policy cache is per instance for planning only; the
execute-time check always reads the database.

## 15. Known limitations

- GitHub OAuth was tested against a local double of GitHub's endpoints (no
  OAuth app/network access here); the exchange code is small and uses the
  production SSRF-safe client, but a first real sign-in should be verified.
- The voice/`run_goal` path (taskPlanner.runLoop, commandRoute) is frozen and
  NOT behind the workspace firewall; it keeps its own risk/approval gates.
- The entropy detector is a heuristic backstop (≈89% of random 32-char
  tokens with ≥3 digits; no false positives on the identifiers tested).
- Policy time windows use UTC hours only.
- Workspace-level GitHub OAuth completion depends on sessionStorage in the
  browser that started it.


## Layer 7 update

- API keys gain the `executions:run` scope; `/api/automation/v1` adds
  `POST /executions` and `GET /executions/:id` and meters every
  authenticated request as an `api_call`. Same key implementation, same
  firewall, approvals and member-rights cap. See `docs/LAYER7_BILLING.md`.

## Layer 9 update

Status of the limitations above after Layer 9 (details: `LAYER9_LIMITATION_LEDGER.md`):

- **L6-1 — EXTERNAL VALIDATION**: GitHub OAuth not verified with a real OAuth app → GitHub OAuth flow tested against a local OAuth double. External step: register a GitHub OAuth/GitHub App, set GITHUB_CLIENT_ID/SECRET/REDIRECT_URI, complete one workspace connect and one refresh.
- **L6-2 — INTENTIONALLY UNSUPPORTED**: Voice/run_goal path not behind the workspace firewall → Voice / run_goal path is frozen; it keeps its own risk and approval gates.
- **L6-3 — INTENTIONALLY UNSUPPORTED**: Entropy detector is heuristic → Entropy detector is a heuristic backstop by design.
- **L6-4 — CLOSED**: Policy time windows are UTC only → schedule.timeZone (IANA, DST-aware via Intl); invalid zones rejected; hardening L6-4.
- **L6-5 — INTENTIONALLY UNSUPPORTED**: Workspace OAuth completion depends on sessionStorage of the starting browser → Binding OAuth completion to the initiating browser is a security property.
- **L6-6 — CLOSED**: OAuth refresh tokens / expiring GitHub user tokens not handled → Expiring GitHub App user tokens and Google tokens are refreshed via the SSRF-safe client, stored encrypted, audited; single flight per instance and re-read across instances for single-use refresh tokens; hardening L6-6.
