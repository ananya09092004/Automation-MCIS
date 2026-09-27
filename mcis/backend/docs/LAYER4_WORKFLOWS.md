# Layer 4 — Workflows + Durable Execution Foundation

Status: implemented 2026-09-24. Requires Layer 1 (workspaces), Layer 2 (tasks) and Layer 3 (agent executions).

```
Workspace → Workflow → Version (immutable) → Run → Task (L2) → Step executions (L3) → Steps / Evidence / Approvals
```

Layer 4 doesn't add a second execution engine. Every workflow step runs as an ordinary Layer 3 execution, so these all come from Layer 3 unchanged:

- planning
- risk tiers
- approvals
- per-action retry, diagnose and replan
- verification
- evidence

Layer 4 adds five things on top: versioned definitions, variables, sequencing, a PostgreSQL-backed durable runner, and conservative crash recovery.

## 1. Data model (`migrations/20260926_layer4_workflows.up.sql`)

| Table | Purpose | Key constraints |
|---|---|---|
| `workflows` | Editable **draft** definition, status `draft\|active\|archived`, trigger config, `revision` counter | `unique (id, workspace_id)`; a scheduled workflow must have an interval and an owner |
| `workflow_versions` | **Immutable** published snapshot: `definition` JSON, `definition_hash` | `unique (workflow_id, version_number)`; a `BEFORE UPDATE` trigger raises an error; composite FK to the workflow in the same workspace |
| `workflow_runs` | One run of one version | FK `(workflow_version_id, workflow_id)`, so the version must belong to the workflow; `unique (workspace_id, idempotency_key)`; `unique (workflow_id, scheduled_for)`; deferred FK to the task in the same workspace |
| `workflow_run_steps` | Per-step state and attempt history; links the Layer 3 execution | `unique (run_id, position)`; `unique (execution_id)`; deferred composite FK to `agent_executions` in the same workspace |
| `workflow_jobs` | Durable job and lease (one per run) | `unique (run_id)`; a `running` job must have an owner and an expiry |
| `agent_executions.inflight` | Additive column: which action is in flight | Written only for workflow step executions |

Row-level security is deny-by-default on every new table. `anon` and `authenticated` have no table privileges and can't call the RPCs; only `service_role` can execute `claim_workflow_job`, `heartbeat_workflow_job` and `release_workflow_job`.

**Rollback:**

1. Deploy the previous code, or set `WORKFLOWS_ENABLED=false`.
2. Run `…down.sql`.

The rollback keeps every Layer 1–3 row, including the executions created by workflow steps. It drops only the five Layer 4 tables and the `inflight` column. Run UP again afterwards to restore the schema; the Layer 4 data itself is not recovered.

## 2. Definitions, versions and templates

- **Definition:** `{ variables[], steps[], policy{maxRunMinutes} }`, validated in `services/workflows/definition.js`.
- **Step fields:** `key`, `name`, `instruction`, `expectedOutput`, `approval` (`auto | required | admin`), `verification` (`best_effort | required`), `retry.maxAttempts` (0–3) and `timeoutMinutes`.
- **Editing** (`PATCH`, which requires the current `revision`) changes only the draft. Concurrent edits get **409**.
- **Publishing:**
  - Each publish creates version *n+1* and makes it active.
  - Re-publishing unchanged content returns the same version (hash comparison).
  - Two concurrent publishes create exactly one new version.
- **Runs pin their version.** A run stores `workflow_version_id` and always reads that immutable snapshot, so editing or re-publishing never changes a run in flight.
- **Templates allow only two forms:** `{{input.<variable>}}` and `{{steps.<earlier_key>.output}}`.
  - No expressions, filters, helpers, property walking or `eval`.
  - Any other `{{…}}` is rejected at save time.
  - Rendering is a single pass, so a value that itself contains `{{…}}` is rendered literally and can't cause template injection.
- **Variables are typed:** string (max length), number, boolean, date (`YYYY-MM-DD`) and enum, each with optional defaults. Required inputs that are missing, unknown inputs and wrong types all get **400**.
- **Secrets:**
  - Input values pass through the existing `sensitiveDataFilter` **before** they are stored, so only redacted values are ever rendered, sent to the planner, stored in evidence or written to audit.
  - Step text written by the author is redacted at save time.
  - Secrets must not be passed as workflow inputs. There's deliberately no secret store.

## 3. Execution (`services/workflows/workflowRunner.js`)

For each step the runner does the following:

1. Renders the goal from the run's redacted inputs and the outputs of earlier steps.
2. Persists the attempt number, then calls `executionService.createExecution` with:
   - the idempotency key `wfrun:<run>:<pos>:<attempt>`
   - `taskId` set to the run's task
   - `approvalPolicy`
   - `trackInflight: true`
3. Polls the execution, heartbeating the lease, and enforces:
   - run cancellation
   - the step timeout
   - the run timeout (`policy.maxRunMinutes`)
   - approval expiry
4. When the execution ends:
   - **Completed:** the step's verification policy is applied (`required` means Layer 3 must report `verified`). The redacted output is stored and the run moves to the next step.
   - **Failed:** the retry decision below is applied.

After the last step, the final verification gives the run `verified`, `not_applicable` or `partially_verified` (the last if any step was unverified or skipped). The task is then marked `done`.

**Retry decision.** Layer 3 already retries idempotent actions and diagnoses and replans inside the execution. At the workflow level, a whole step is re-run automatically only if all three conditions hold:

1. The failure code is transient: `TOOL_FAILURE`, `TIMEOUT`, `BROWSER_FAILURE`, `INVALID_RESULT`, `MISSING_DATA`, `PLANNER_ERROR`, `EXECUTION_TIMEOUT`, `MAX_STEPS`, `SERVER_RESTART`, `ENGINE_ERROR` or `INVALID_STEP`.
2. Nothing the execution did could have changed state:
   - every recorded action, **and the action that was in flight**, is in `SAFE_TO_REPEAT_ACTIONS` (read, navigate, inspect and so on)
   - no human-approved action was attempted
3. Attempts remain (`1 + retry.maxAttempts`).

If the attempts are used up, the step fails. If a retry can't be proven safe, the run pauses as **`needs_review`**. The initiator or an admin then picks `retry_step` (exactly one more, human-authorized attempt), `skip_step` or `fail`.

These failures are never retried: `NEEDS_INPUT`, `APPROVAL_REJECTED`, `APPROVAL_EXPIRED`, `PERMISSION_DENIED`, `VERIFICATION_FAILED`, timeouts, cancellation and emergency stop.

**Approvals reuse Layer 3.** A step's `approval: required | admin` raises every *non-read-only* action to YELLOW or RED, so it goes through the existing approval gate. Approvals are decided at `POST /workflow-runs/:run/steps/:pos/approvals/:id/(approve|reject)`. The service first checks the chain workspace → run → current step → that step's execution, then calls `executionService.decideApproval`, which enforces:

- role: YELLOW needs the initiator or an admin; RED needs an admin
- the step hash, which rejects stale approvals
- expiry
- single use (a replay gets 409)

A pending approval from an interrupted execution dies with it and can never be replayed.

**Tasks (Layer 2).** Each run creates one task, or uses one given as `taskId` (same workspace, and the caller must be allowed to work on it). The task:

- is assigned to the AI agent
- gets a deterministic id derived from the run id, so a recovery can't create a duplicate
- is linked to every step execution through `agent_executions.task_id`
- moves `in_progress` → `done` (completed), `blocked` (failed) or `cancelled`

## 4. Durable runner

- **Claim:** `claim_workflow_job(worker, lease)` uses `FOR UPDATE SKIP LOCKED`. It picks the oldest due `queued` job, **or** a `running` job whose lease expired, which counts as a recovery (`recoveries + 1`).
- **Heartbeat:** `heartbeat_workflow_job` extends the lease only for its current owner (every 15 s against a 60 s lease by default).
- **Release:** `release_workflow_job` is owner-only. It moves the job to `completed`, `failed`, `cancelled`, `paused` (needs review) or `queued` (retry with backoff).
- **Fencing:** before starting an attempt or settling a step, the worker re-reads the job. If it no longer owns the lease, it stops writing.
- **Recovery:** when a new worker claims an expired lease:
  - it adopts the run at the persisted current step
  - Layer 3 reconciles the orphaned execution to `SERVER_RESTART`, keeping its evidence and in-flight marker
  - the safety rule above decides between retry and `needs_review`
- **Limits:**
  - `max_recoveries` (default 3), after which the run fails with `RECOVERY_EXHAUSTED`
  - job attempts, capped at 50, with backoff between retries
  - a hard loop bound in the driver
- **Orphans:** if the process dies between inserting a run and inserting its job, the scheduler sweep creates the missing job.
- **Clock:** job `run_at` and lease expiry use the **database** clock, so app/DB clock skew can't delay or steal jobs.

### Scheduling

Triggers are `manual`, `api` (requires an `Idempotency-Key` and must be enabled per workflow) or `scheduled` (every N minutes, 15–10080; configured by admin+ only; inputs are validated against the active version).

The scheduler tick runs every 30 s in the worker:

1. It claims a slot by compare-and-set on `next_run_at`.
2. It creates the run with `scheduled_for = slot`. The `unique (workflow_id, scheduled_for)` constraint guarantees no duplicate run for a slot.
3. Missed slots are not back-filled.
4. It re-checks that the schedule owner is still an admin member. If not, the schedule is disabled and audited instead of run.

There was no cron infrastructure in the repo to reuse (jobs were only triggered over HTTP), so the scheduler is part of the same Postgres-backed worker.

### Deployment

- Apply the migration first, then deploy the code.
- `WORKFLOWS_ENABLED=false` turns off the routes and the worker.
- `WORKFLOW_WORKER_ENABLED=false` turns off only the worker.
- **Run the worker in exactly one backend instance.** Layer 3 runtimes are in-process; this Layer 3 limitation is unchanged.

## 5. API (all behind Firebase auth + Layer 1 membership; non-members get 404)

`/api/workspaces/:ws/workflows`:

| Method | Path | Notes |
|---|---|---|
| GET | `/` | |
| POST | `/` | |
| GET | `/:id` | |
| PATCH | `/:id` | requires `revision` |
| POST | `/:id/publish` | |
| POST | `/:id/archive` | |
| POST | `/:id/activate` | |
| PUT | `/:id/trigger` | |
| GET | `/:id/versions/:n` | |
| POST | `/:id/runs` | `Idempotency-Key` supported |
| GET | `/:id/runs` | |

`/api/workspaces/:ws/workflow-runs`:

| Method | Path |
|---|---|
| GET | `/` |
| GET | `/:run` |
| GET | `/:run/evidence` |
| POST | `/:run/cancel` |
| POST | `/:run/resolve` |
| POST | `/:run/steps/:pos/approvals/:id/approve` |
| POST | `/:run/steps/:pos/approvals/:id/reject` |

### Roles

| Operation | member | admin/owner |
|---|:-:|:-:|
| View workflows, versions, runs, evidence | ✓ | ✓ |
| Create a workflow (draft) | ✓ | ✓ |
| Edit, publish, archive, re-activate | creator | ✓ |
| Configure triggers or a schedule | – | ✓ |
| Start a run (active workflows only) | ✓ | ✓ |
| Cancel or resolve a run | initiator | ✓ |
| Approve a step action | initiator (YELLOW) | ✓ (YELLOW + RED) |

### Audit

Actions recorded, each with a `workspace_id`:

- `workflow_created`, `workflow_updated`, `workflow_published`, `workflow_archived`, `workflow_activated`, `workflow_trigger_set`
- `workflow_run_started`, `workflow_run_completed`, `workflow_run_failed`, `workflow_run_cancelled`, `workflow_run_cancel_requested`
- `workflow_run_needs_review`, `workflow_run_resolved`, `workflow_run_recovered`
- `workflow_step_retry`, `workflow_run_approval_(approve|reject)`
- `workflow_schedule_disabled`, `workflow_schedule_skipped`
- plus the existing Layer 3 execution events

## 6. Layer 3 changes (additive only)

- `createExecution(ctx, { …, approvalPolicy, trackInflight })`. Both default to off, so plain Layer 3 behaviour is unchanged.
- An in-flight marker is written before each executor call, **only** when `trackInflight` is set. If that write fails, the action is not executed.
- Internal hooks, not routed: `hasRuntime(id)` and `abortExecution(ws, id, {status, code, message})`.
- `executionStore.setInflight` writes its own column without a version bump.

## 7. Frontend (`mcis/frontend/src/workflows/`)

The page is at `/workflows` (routed in `index.js`; a "Workflows" link was added to the chat sidebar). It provides:

- the current workspace and a switcher; the list comes from the server and the remembered choice is re-validated
- the workflow list, create, and details with publish/archive
- run with inputs (one `Idempotency-Key` per click)
- run history and run detail: step status, the pending approval with approve/reject, review actions and an evidence summary

A 404 on the selected workspace falls back to the personal workspace. The UI is not an authorization layer; every call is re-authorized by the backend. Existing chat, memory and goals calls still don't send `X-Workspace-Id`, which is unchanged.

## 8. Known limitations

- **One worker instance.** Layer 3 runtimes are in-process. A second backend instance that serves execution reads could reconcile another instance's live execution as `SERVER_RESTART`.
- **Linear steps only.** No branching, parallelism or DAGs, by design. Steps are strictly sequential.
- **Output chaining is text only.** A step's output is the redacted completion message from the Layer 3 planner, capped at 1000 characters; there's no structured data passing.
- **Waiting runs hold a worker slot.** A run waiting for approval holds its lease and one of `maxConcurrent` (5) slots. An unanswered approval expires after 15 minutes and fails the step.
- **Schedules are simple.** They are interval-based (every N minutes), not cron expressions or calendars, and there's no timezone handling.
- **API triggering uses the user token.** API-triggered runs still use a Firebase user token; there are no API keys yet.
- **Retries are conservative.** Any executed action outside `SAFE_TO_REPEAT_ACTIONS` makes an automatic retry "unsafe". Some transient failures therefore need a human `retry_step`.


## Layer 6 update

- Durable jobs are fenced: `claim_workflow_job_v2` increments `lease_fence`;
  heartbeat/release (`_v2`) and the runner's consequential transitions
  require owner AND fence. Several workers may run the loop.
- Steps may declare typed `outputs` referenced as
  `{{steps.<key>.outputs.<name>}}`; they are validated before later steps
  see them (`OUTPUT_INVALID` otherwise).
- API-triggered runs are started with workspace API keys through
  `/api/automation/v1` and act with member rights.
See `docs/LAYER6_SECURITY.md`.


## Layer 7 update

- `createRunRecord` reserves the `workflow_runs` quota (keyed by the
  request's Idempotency-Key / schedule slot, so duplicates are free);
  publishing or re-activating a workflow checks `active_workflows`.
  A retried step is charged one execution. See `docs/LAYER7_BILLING.md`.

## Layer 9 update

Status of the limitations above after Layer 9 (details: `LAYER9_LIMITATION_LEDGER.md`):

- **L4-1 — CLOSED**: One worker instance → Fenced multi-worker jobs; Layer 9 two-worker test.
- **L4-2 — INTENTIONALLY UNSUPPORTED**: Linear steps only → Linear steps by design.
- **L4-3 — CLOSED**: Output chaining is text only → Structured outputs: string, number, boolean, object, array + Layer 9 table ({columns, rows}, bounded, scalar cells) and artifact reference (https or opaque id, no credentials/traversal); text outputs unchanged.
- **L4-4 — INTENTIONALLY UNSUPPORTED**: Waiting runs hold a worker slot → Waiting runs hold a slot, bounded by approval TTL and maxConcurrent.
- **L4-5 — INTENTIONALLY UNSUPPORTED**: Schedules are interval-based, no cron/timezone → Interval schedules by design (policy time windows now support IANA zones, L6-4).
- **L4-6 — CLOSED**: API triggering uses the user token → Obsolete: Layer 6 API keys.
- **L4-7 — INTENTIONALLY UNSUPPORTED**: Retries are conservative (non-idempotent actions need human retry) → Required safety rule: uncertain writes are never auto-replayed (needs_review); proven by the two-worker test.
