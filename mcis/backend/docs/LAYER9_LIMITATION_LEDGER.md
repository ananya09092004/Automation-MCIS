# Layer 9 — limitation ledger

Every limitation found in the Layer 1–8 documents, TODOs and the Layer 9 audit, with its class (A fix in code · B external credentials · C production environment · D intentionally unsupported · E obsolete) and final status. Machine-readable: `LAYER9_LIMITATION_LEDGER.json`.

## CLOSED (41)

| Id | Class | Limitation | Resolution |
|---|---|---|---|
| L1-1 | E | Existing legacy data is per user, not per workspace | Obsolete: Layer 2 scoped chats/memory/goals; the rest is L2-1/L2-2. |
| L1-2 | E | No frontend workspace UI | Obsolete: workspace switcher on every Layer 4/8 page and /workspace. |
| L1-3 | A | No ownership transfer | POST /api/workspaces/:id/transfer-ownership {newOwnerId}; RPC transfer_workspace_ownership (one transaction); UI in Workspace → Team; hardening L1-3 (memory + Postgres). |
| L1-5 | A | Frontend does not send verification emails although invites require a verified email | Auth.js sends the Firebase verification email on sign-up; Workspace → Team offers "Send verification email"; frontend tests. |
| L1-6 | A | No rate limit on invite acceptance | DB-backed limiter: 20 acceptances / 10 min per user → 429; hardening L1-6. |
| L2-2 | A | Cron/proactive jobs, command-center and data-controls read all of a user's rows across workspaces | Data export/erasure cover only the caller's OWN rows (data-subject rights), now audited (data_exported / data_deleted, counts only); secret-looking columns are redacted in exports; DB error text is no longer returned. Cron/proactive jobs read only the owner's rows (unchanged by design). |
| L2-4 | A | auth.js treats /notifications/:x as a user id for every method (PATCH/DELETE broken) | auth.js matches the user id only for GET /notifications/:userId; PATCH /:id/read and DELETE /:id are owner-checked in the route; hardening L2-4. |
| L2-8 | A | Web app does not send X-Workspace-Id for chat/memory/goals | authFetch attaches X-Workspace-Id to /api/chat, /api/memory, /api/goals (also for callers that set Authorization themselves); a left workspace (404) is forgotten and retried in the personal one; frontend tests. |
| L3-1 | E | Single backend instance; runtime in-process | Execution leases + fenced jobs (Layer 6); Layer 9 deterministic two-worker crash test; load test with 20 tenants. |
| L3-5 | A | Planner input is not redacted | Goal and history sent to the planner are always sanitized, even with the firewall off; agentExecution redaction test now asserts NO secret reaches any prompt (stricter). |
| L3-6 | E | No UI for executions | Obsolete: Layer 8 Activity & approvals. |
| L4-1 | E | One worker instance | Fenced multi-worker jobs; Layer 9 two-worker test. |
| L4-3 | E | Output chaining is text only | Structured outputs: string, number, boolean, object, array + Layer 9 table ({columns, rows}, bounded, scalar cells) and artifact reference (https or opaque id, no credentials/traversal); text outputs unchanged. |
| L4-6 | E | API triggering uses the user token | Obsolete: Layer 6 API keys. |
| L5-3 | A | HTTP connector: no query-string auth | HTTP connector authType "query" (authQueryParam); key never in evidence/audit/logs; clients cannot set that parameter; redirects not followed; hardening L5-3. |
| L5-6 | A | Credential rotation manual; no re-encryption job | scripts/rotate-integration-keys.js re-encrypts every credential under the current key (CAS, dry run, counts only); tested memory + Postgres incl. concurrent runs. |
| L5-7 | E | Legacy GitHub OAuth plaintext tokens + guessable state | Obsolete: Layer 6 moved legacy GitHub tokens into the encrypted store. |
| L6-4 | A | Policy time windows are UTC only | schedule.timeZone (IANA, DST-aware via Intl); invalid zones rejected; hardening L6-4. |
| L6-6 | A | OAuth refresh tokens / expiring GitHub user tokens not handled | Expiring GitHub App user tokens and Google tokens are refreshed via the SSRF-safe client, stored encrypted, audited; single flight per instance and re-read across instances for single-use refresh tokens; hardening L6-6. |
| L7-1 | E | No payment provider | Obsolete: Layer 8 Stripe adapter. |
| L7-2 | A | Count-based limits checked, not reserved (members, active workflows) | members and active_workflows: post-write verification under a per-workspace row lock (RPCs enforce_member_limit / enforce_active_workflow_limit); an over-limit writer undoes its own write. Exactly the free capacity is granted under concurrency (memory + Postgres). |
| L7-3 | E | Connector-call limits checked not reserved | Obsolete: one active execution per workspace is a DB unique index; connector calls are reserved per execution. |
| L7-4 | A | Usage retention only bounds the API; ledger rows never deleted | Real retention: RPC retention_purge_workspace (usage ledger, reservations, finished runs/executions + cascades, audit) with DB-enforced floors; owner settings, "Apply now", periodic sweep on workers; audited with counts; tested on Postgres. |
| L7-5 | A | max_concurrent_executions informational | max_concurrent_executions enforced in createExecution (0 → 402 before anything starts). |
| PRE-1 | A | Emergency stop is global (voice route) | Workspace emergency stop in the firewall policy (owner/admin, Security page); denies every agent/connector action before it is sent; hardening PRE-1. |
| P1-1 | A | Migrations create pgcrypto (local test needed a placeholder extension) | pgcrypto created only if available; L1–L9 up/down applied on a fresh PostgreSQL 16 with the pgcrypto extension REMOVED from the server. |
| P1-2 | A | Schema invariants not verified automatically | scripts/schema-audit.sql: RLS, anon/authenticated privileges and policies, workspace_id FK + index, RPC execute grants; 0 violations; negative control detects injected violations. |
| P7-1 | A | Adversarial prompt-injection regression suite | Injection regression: Drive document, GitHub issue title, API response → tainted, a following write waits for a human, policy/roles unchanged, nothing sent to the attacker. |
| P9-1 | A | Approval binding verification across all properties | Approval: replay (one winner), cross-workspace and cross-execution 404, reuse 409; plus the Layer 6 AA/AB binding tests (step, policy version, input tamper, expiry). |
| P12-1 | A | API lacks list endpoints, pagination/filtering and request IDs | GET /api/automation/v1/runs and /executions with keyset cursors, status/workflow filters, key workflow restrictions, X-Request-Id; OpenAPI updated (spec-vs-router test). |
| P13-1 | A | No worker health / ops metrics | Worker heartbeats, /health/ready, token-protected /metrics (route groups only), request ids in responses and error logs. |
| P15-1 | A | ALLOW_UNAUTHENTICATED_API=true disables auth even with NODE_ENV=production | ALLOW_UNAUTHENTICATED_API is ignored when NODE_ENV=production (fail closed, logged). |
| P17-1 | A | No load test | __tests__/load/loadTest.js measured on memory and on local PostgreSQL (see LAYER9_HARDENING.md §6). |
| P18-1 | A | No production runbook | docs/PRODUCTION_RUNBOOK.md; check-config extended. |
| P4-1 | A | No repository/database/runtime secret scan tooling | scripts/secret-scan.js (repository + --db); runtime scan in the Layer 9 suite. |
| L9-N1 | A | authFetch attached the Firebase ID token to ANY origin whose path starts with /api/ | Token only for same-origin /api/ or configured backend origins; frontend test. |
| L9-N2 | A | Generated code awaiting a GitHub push was kept in localStorage; push result opened with window.open without noopener | sessionStorage (tab-scoped); https-only window.open with noopener,noreferrer. |
| L9-N3 | A | Count-limit compensation could deny ALL concurrent writers on Postgres (livelock) | Serialized verification RPCs (L7-2). |
| L9-N4 | A | Ownership-transfer body field "userId" collided with the auth middleware's caller check | Field renamed newOwnerId (found by the Layer 9 HTTP test). |
| L9-N5 | A | Layer 9 down migration restored the Layer 7 trigger with different whitespace | Down restores the Layer 7 body byte-identically (md5 checked). |
| L9-N7 | E | Browser/desktop/file safety for dangerous actions | Existing Layer 6 firewall (AB tests: deletes, credential files, uploads, protected paths, terminal, session export) re-verified; workspace emergency stop added (PRE-1). No engine change. |

## EXTERNAL VALIDATION (6)

| Id | Class | Limitation | Resolution |
|---|---|---|---|
| L5-1 | B | GitHub authenticated reads/writes not tested against real GitHub | GitHub reads/writes are tested against a local GitHub API double only. External step: connect a real repository with a fine-grained PAT and run list_issues/read_file/create_issue once. |
| L5-2 | A | Google Drive not implemented | Read-only Google Drive connector (list_files, get_file, read_text) through the gateway + firewall, folder allowlist, token refresh, workspace OAuth connect — tested against a local Drive/Google-token double. External step: create a Google OAuth client, set GOOGLE_DRIVE_ENABLED + GOOGLE_OAUTH_*, connect a test Google account, run the three actions (Google app verification is needed for external users). |
| L6-1 | B | GitHub OAuth not verified with a real OAuth app | GitHub OAuth flow tested against a local OAuth double. External step: register a GitHub OAuth/GitHub App, set GITHUB_CLIENT_ID/SECRET/REDIRECT_URI, complete one workspace connect and one refresh. |
| L8-1 | B | Stripe not exercised against Stripe test mode | Stripe tested against a deterministic Stripe API double only (no Stripe account/keys supplied). External step: the test-mode checklist in PRODUCTION_RUNBOOK.md §6 with sk_test keys and a webhook endpoint. |
| L8-2 | C | Plan changes via Stripe Customer Portal configuration | Plan changes for existing subscribers use the Stripe Customer Portal; its products must be configured in the Stripe dashboard. |
| L8-6 | C | First safe task needs the desktop bridge | Desktop/browser actions need a running Nexus desktop agent on the customer machine. |

## INTENTIONALLY UNSUPPORTED (23)

| Id | Class | Limitation | Resolution |
|---|---|---|---|
| L2-1 | D | Personalisation (profile, twin, timeline, graph…) is per user, used as prompt context in every workspace | Legacy personal-assistant data is per user by design and never shown to other users. |
| L2-3 | A | Uploaded PDFs (pdf_vectors) not workspace-scoped | pdf_vectors are private to the uploader (user_id scoped, never shared across users); workspace sharing of uploads would need pgvector RPC changes and is not an access-control gap. |
| L2-5 | D | Unscoped writers (voice) land in the personal workspace | Voice is frozen and has no workspace concept; its writes land in the personal workspace. |
| L2-6 | D | Memory search fails closed without pgvector search_memories_scoped | Memory search fails closed without the pgvector RPC (safe default); documented. |
| L2-7 | D | Tasks do not auto-complete when an execution completes | Humans confirm task completion by design. |
| L3-2 | D | Cancellation takes effect between steps | A step already sent to the desktop cannot be recalled; evidence is kept. |
| L3-3 | D | Clarification ends the execution (NEEDS_INPUT) | Clarification ends the execution (NEEDS_INPUT) by design. |
| L3-4 | C | Nexus ApprovalGate only checks token presence | Inspected (read-only) nexus/common/approval.py: ApprovalGate checks token presence; the bridge only accepts requests carrying NEXUS_DEVICE_TOKEN from the backend, which is the approval authority (approvals are bound and single-use there). Verifying server-signed tokens inside Nexus would change controller.py's voice approval path, which is frozen. check-config now REQUIRES NEXUS_DEVICE_TOKEN whenever NEXUS_URL is set and https/loopback in production. |
| L4-2 | D | Linear steps only | Linear steps by design. |
| L4-4 | D | Waiting runs hold a worker slot | Waiting runs hold a slot, bounded by approval TTL and maxConcurrent. |
| L4-5 | D | Schedules are interval-based, no cron/timezone | Interval schedules by design (policy time windows now support IANA zones, L6-4). |
| L4-7 | D | Retries are conservative (non-idempotent actions need human retry) | Required safety rule: uncertain writes are never auto-replayed (needs_review); proven by the two-worker test. |
| L5-4 | D | HTTP connector: POST bodies JSON ≤16 KB | POST bodies are JSON ≤16 KB by design. |
| L5-5 | D | HTTP connector: only JSON/text responses parsed | Binary responses are not fed to the agent by design. |
| L6-2 | D | Voice/run_goal path not behind the workspace firewall | Voice / run_goal path is frozen; it keeps its own risk and approval gates. |
| L6-3 | D | Entropy detector is heuristic | Entropy detector is a heuristic backstop by design. |
| L6-5 | D | Workspace OAuth completion depends on sessionStorage of the starting browser | Binding OAuth completion to the initiating browser is a security property. |
| L8-3 | D | Display prices operator-set, not read from Stripe | Display prices are operator-set (no provider call per page view). |
| L8-5 | D | Overview latency/success uses the last 50 records | Bounded overview queries by design; 30-day totals come from the ledger. |
| PRE-2 | D | Voice resume re-asks planner; RED always 403 on /api/command; resumePlan unreachable | Voice/planner frozen. |
| PRE-3 | D | PERMISSIONS_ENFORCED follow-ups (voice re-send, extra round trip) | Voice frozen; check-config warns while PERMISSIONS_ENFORCED is not true. |
| TODO-1 | D | Legacy productivity module keeps Google tokens/reminders in memory | Legacy personal productivity module (in-memory only, outside Nexus B2B). |
| TODO-2 | D | Legacy UI TODO | Legacy personal dashboard widget TODO. |

## REMAINING (3)

| Id | Class | Limitation | Resolution |
|---|---|---|---|
| L1-4 | B | No email delivery for invitations | Invitations are shared as one-time codes. Emailing them needs an email provider and a verified sending domain that this project does not have; nothing was faked. Exact step: pick a provider, add an invitation mailer that sends the existing one-time link. |
| L8-4 | B | Invitations not emailed | Same as L1-4 (email provider). |
| L9-N6 | A | Occasional timing failure of a Layer 4 restart-recovery test when the whole backend suite runs back-to-back (pre-existing; seen once in Layer 8 and once in Layer 9; passes in isolation and on reruns) | Pre-existing, cause not identified: in 2 of ~12 full back-to-back suite runs one Layer 4 restart-recovery test failed; it passes in isolation and on every rerun, on memory and Postgres. Not changed (tests are not weakened). Product code is not involved (the test simulates process crashes with timed lease expiry). |
