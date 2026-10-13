# Layer 3: Agent Execution & Verification

Status: implemented 2026-09-23. Requires Layer 1 (workspaces).

**Note on Layer 2:** the repo has no separate Layer 2 implementation. The only work between Layer 1 and this layer is the pre-Layer-2 security fixes (`docs/SECURITY_FIXES_PRE_LAYER2.md`). Layer 3 is built directly on Layer 1 plus those fixes.

## What it does

A workspace member starts a goal. The backend runs it through the **existing** Nexus planner and executor as a persisted execution with this lifecycle:

```
created → planning → executing → planning → … → verifying → completed
                 ↘ waiting_approval → executing   (YELLOW / RED / ungranted / executor-gated steps)
any active state → failed | cancelled
```

On each iteration the engine:

1. **Plans** the next step with `taskPlanner.decideNextStep` (same planner and prompt as voice).
2. **Gates** the step: `riskModel.classifyRisk` plus `permissions.isPermitted`.
3. **Executes** it with `taskPlanner.callNexusWithTimeout` (with an approval token only for human-approved steps).
4. **Observes and verifies** it using executor evidence.
5. **Recovers** within a bounded budget:
   - **Idempotent steps** (`SAFE_TO_REPEAT_ACTIONS`) get one retry.
   - **Other steps** get one `diagnoseFailure` inspection, then a re-plan with that diagnosis in the history.
6. **Persists** redacted evidence for the step.

The voice pipeline and its plan runner (`taskPlanner.runLoop`, `/api/command`, voice routes) are unchanged. Layer 3 is a separate executor built on the same primitives.

## Approval policy

| Step | Gate | Who can approve |
|---|---|---|
| GREEN, permitted | none (runs automatically) | — |
| GREEN, `isPermitted` false (only when `PERMISSIONS_ENFORCED=true`) | approval, reason `permission_required` | creator, or admin/owner |
| YELLOW (`write_file`, `fill_form`, `type_text`, …) | approval | creator, or admin/owner |
| RED (`delete_*`, `run_terminal`, `kill_process`, payment/login/booking keywords) | approval | **admin or owner only** |
| Any step the Nexus `ApprovalGate` refuses without a token | approval, reason `executor_approval_gate` | by tier |

How approvals are protected:

- **Scope.** An approval belongs to exactly one workspace, execution and step. Lookups always use all three IDs, and database foreign keys enforce that the workspace matches the execution.
- **Staleness.** An approval is valid only while:
  - it is `pending`,
  - it has not expired (15-minute TTL),
  - it is the execution's current `pending_approval_id`,
  - and the SHA-256 of the exact pending step still matches.

  Otherwise the request is refused with 409 `STALE_APPROVAL`, 409 `APPROVAL_NOT_PENDING`, or 410 `APPROVAL_EXPIRED`. An expired approval also fails the execution.
- **Single use.** Deciding an approval is a compare-and-set, so concurrent or replayed approvals produce exactly one success.
- **Scoped token.** Approving mints a random per-step `approval_token` that is sent to Nexus for that one step only.

## Failure handling

Every stop is bounded:

- 3 consecutive step failures
- 15 steps (`MAX_STEPS`)
- 2 planner errors
- a 30-minute execution deadline
- a hard loop guard

| Code | Meaning |
|---|---|
| `TOOL_FAILURE` | The executor reported a failure. |
| `TIMEOUT` | A step timed out (30 s bridge limit, or Nexus's 504). |
| `BROWSER_FAILURE` | A browser-platform step failed. |
| `INVALID_RESULT` | The executor returned a malformed result. |
| `INVALID_STEP` | The planner proposed an unknown action. |
| `MISSING_DATA` | A read action succeeded but returned no data. |
| `VERIFICATION_FAILED` | A state-changing step returned `evidence.verified=false`. Completion is refused while this is unresolved. |
| `PERMISSION_DENIED` | The executor refused a step even after approval. |
| `APPROVAL_REJECTED` | A human rejected the step. |
| `APPROVAL_EXPIRED` | The approval was not decided within its TTL. |
| `NEEDS_INPUT` | The planner needs clarification. The question is returned in `result.question`. |
| `PLANNER_ERROR` | The planner was unavailable or its response could not be parsed. |
| `MAX_STEPS` | The step limit was reached. |
| `EXECUTION_TIMEOUT` | The execution exceeded its deadline. |
| `CANCELLED` | A user cancelled the execution. |
| `EMERGENCY_STOP` | The existing global kill switch cancelled it. It also blocks new executions. |
| `SERVER_RESTART` | See "Deployment notes" below. |
| `ENGINE_ERROR` | An unexpected error inside the executor. |

The verification result stored on a completed execution is one of:

- `verified`: every state-changing step has `verified=true` evidence.
- `unverified`: some state-changing step returned no evidence, or nothing was executed.
- `not_applicable`: only read-only or low-risk steps ran.

## Evidence and redaction

Each attempted step stores:

- action, tool (platform) and risk tier
- status and number of attempts
- a summary of parameters and target
- the output message, a data summary (arrays are reduced to their length plus a 3-item sample) and executor evidence (verified flag, screenshot paths)
- verification status and note
- error code and message
- recovery details (strategy, whether it recovered, whether a diagnosis was captured)
- approval ID and timestamps

Everything persisted, returned or audited goes through `backend-routing/sensitiveDataFilter.js`. This file already existed in the repo as an empty placeholder and is now implemented. It redacts:

- values under sensitive keys (password, token, api key, otp, cvv, pin, aadhaar, pan, …)
- bearer tokens and JWTs, PEM private keys, and API keys from AWS, Google, GitHub, Slack, Stripe, and OpenAI-style `sk-` keys
- `password=…` style pairs
- Luhn-valid card numbers, Aadhaar numbers and PAN numbers
- the typed `value` of any action whose target is a secret field (for example `fill` into a "Password" box)

The goal is stored **redacted**. The raw goal and raw step payloads exist only in process memory for the planner and executor, as they do for voice.

Audit entries are written through the existing `appendAuditLog` (redacted) for create, approve, reject, cancel and every terminal state.

## Idempotency and concurrency

- `Idempotency-Key` header (or `idempotencyKey` in the body), unique per workspace:
  - same key and same goal: 200 with the original execution
  - same key and a different goal: 409 `IDEMPOTENCY_CONFLICT`
- At most **one active execution per workspace**, enforced by a unique partial index. A second create returns 409 `EXECUTION_IN_PROGRESS` with `activeExecutionId`. Other workspaces are unaffected.
- Every execution state change is compare-and-set on `status` and `version`.
- IDs are UUIDv4 and approval tokens are 192-bit random. Workspace and user identity always come from the server (Layer 1 context and the Firebase token), never from the request body.

## API

Mounted at `/api/workspaces/:workspaceId/executions`. All routes require a Firebase ID token and workspace membership; non-members get 404.

```
POST   /                                         { goal, idempotencyKey? }  → 201 (200 on idempotent replay)
GET    /?limit=20
GET    /:executionId            status, currentStep, currentAction, progress, waitingForApproval,
                                result, failure, verification, evidenceSummary
GET    /:executionId/evidence   redacted steps + approvals
POST   /:executionId/approvals/:approvalId/approve   { note? }
POST   /:executionId/approvals/:approvalId/reject    { note? }
POST   /:executionId/cancel     creator or admin/owner
```

The voice device token (`X-Device-Token`) is **not** accepted on these routes.

## Migration and rollback

1. Apply Layer 1 first.
2. Run `migrations/20260924_layer3_agent_executions.up.sql`. It is idempotent and only adds three tables (RLS deny-by-default, composite foreign keys, unique partial indexes).
3. To roll back: remove the `executionsRoute` mount in `server.js`, then run `…down.sql`, which drops only the three Layer 3 tables.

## Deployment notes and limitations

- **Single backend instance.** The runner is in-process, like `taskPlanner`. An active execution whose runtime is not in the current process (after a restart or redeploy) is marked `failed` with `SERVER_RESTART` the next time it is read or blocks a new create. It is never resumed automatically, because raw payloads and approvals lived only in memory. Horizontal scaling needs a job queue with leases (next layer).
- **Cancellation takes effect between steps.** A step already sent to Nexus finishes. Its evidence is recorded, and nothing further runs.
- **Clarification ends the execution.** A planner clarification request fails the execution with `NEEDS_INPUT`; there is no mid-execution answer API yet.
- **Nexus token check is shallow.** Nexus's `ApprovalGate` validator only checks that a token is present, which is the existing security model. Tokens are not yet cryptographically verified on the Nexus side.
- **Planner input is not redacted.** Data sent to the planner LLM is unchanged from existing behaviour.
- **Goal text is sanitized.** The goal passes through the existing XSS sanitizer (HTML-escaped), the same as `/api/command`.
- **No UI.** There is no frontend for executions yet; the API is backend-only.

## Tests

`npm test` runs `__tests__/agentExecution.test.js`, 37 tests. To run the same suite against a disposable Postgres behind PostgREST, set `WORKSPACE_TEST_STORE=supabase`.


## Layer 6 update

- Every step now passes the Agent Firewall twice (when planned and right
  before it executes) when `SECURITY_FIREWALL_ENABLED` is on; denials are
  recorded as not-executed evidence (`POLICY_DENIED` / `STALE_APPROVAL`).
- Approvals are bound (`binding_hash`, `policy_version`) and re-checked on
  decision; API keys can never decide one.
- Multi-instance: executions carry an ownership lease
  (`lease_expires_at`, 30 s, `MULTI_INSTANCE_EXECUTION=false` to disable).
  Another instance leaves a leased execution alone and can record approval
  decisions for it; an execution is failed as `SERVER_RESTART` only after its
  lease expired (so a single instance restart now waits up to 30 s before
  failing interrupted executions).
- Stored/returned values go through `services/security/sensitiveClassifier.js`.
See `docs/LAYER6_SECURITY.md`.


## Layer 7 update

- `createExecution` reserves the `executions` quota before the row exists
  (402 `QUOTA_EXCEEDED` / 503 `ENTITLEMENT_UNAVAILABLE` when billing is
  enforced) and records `agent_execution`, executed steps, connector calls and
  the final outcome in the usage ledger. Connector steps check the
  `connector_calls` quota before sending; a refusal is not-executed evidence
  (`QUOTA_EXCEEDED`). See `docs/LAYER7_BILLING.md`.

## Layer 9 update

Status of the limitations above after Layer 9 (details: `LAYER9_LIMITATION_LEDGER.md`):

- **L3-1 — CLOSED**: Single backend instance; runtime in-process → Execution leases + fenced jobs (Layer 6); Layer 9 deterministic two-worker crash test; load test with 20 tenants.
- **L3-2 — INTENTIONALLY UNSUPPORTED**: Cancellation takes effect between steps → A step already sent to the desktop cannot be recalled; evidence is kept.
- **L3-3 — INTENTIONALLY UNSUPPORTED**: Clarification ends the execution (NEEDS_INPUT) → Clarification ends the execution (NEEDS_INPUT) by design.
- **L3-4 — INTENTIONALLY UNSUPPORTED**: Nexus ApprovalGate only checks token presence → Inspected (read-only) nexus/common/approval.py: ApprovalGate checks token presence; the bridge only accepts requests carrying NEXUS_DEVICE_TOKEN from the backend, which is the approval authority (approvals are bound and single-use there). Verifying server-signed tokens inside Nexus would change controller.py's voice approval path, which is frozen. check-config now REQUIRES NEXUS_DEVICE_TOKEN whenever NEXUS_URL is set and https/loopback in production.
- **L3-5 — CLOSED**: Planner input is not redacted → Goal and history sent to the planner are always sanitized, even with the firewall off; agentExecution redaction test now asserts NO secret reaches any prompt (stricter).
- **L3-6 — CLOSED**: No UI for executions → Obsolete: Layer 8 Activity & approvals.
