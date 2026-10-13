# Privacy and data controls

This describes what personal data this product stores, where, and what
control a user has over it. It is not a legal privacy policy for an
operator's customers — an operator deploying this product is responsible
for publishing one, and should make sure it matches what's actually true
below rather than a generic template.

## What is stored, and where

- **Account identity**: Firebase Authentication (email, password hash —
  password hashing is handled entirely by Firebase, never by this
  codebase; email-verification status).
- **Product data**: Supabase (Postgres) — chats and messages, long-term
  memory (vector embeddings + text), goals and goal plans, workspace and
  team membership, workflow/execution records and their evidence,
  integration connections (encrypted credentials — see `SECURITY.md`),
  billing/subscription state and usage ledger, audit logs.
- **Files**: uploaded documents/images are processed and, depending on the
  feature, stored via the configured media provider (e.g. Cloudinary) or
  not retained beyond the request.
- **Local device state** (if the optional desktop/voice agent is used):
  pairing/device tokens and local session files on the user's own
  machine — never uploaded as part of this backend's own data.

## Export and deletion

Every account can export or permanently delete their own data through the
in-app **Settings → Data controls** panel
(`mcis/frontend/src/SettingsPanel.js`'s `DataControlsPanel`), backed by
`mcis/backend/routes/dataControls.js`:

- **Export** returns every table scoped to that user as JSON. Credential
  columns (integration tokens, access/refresh tokens) are redacted
  (`[REDACTED]`) in the export — an export is a record of *what exists*,
  not a way to extract a live credential.
- **Delete** requires typing the literal confirmation word `DELETE` (both
  in the UI and in the API request body) before anything is removed, and
  removes the account's data across every table listed in
  `services/dataControlsService.js`. It's refused while an active paid
  subscription or a running execution exists, to avoid deleting data out
  from under in-flight billing/work.
- Both actions are **audited** (`data_exported` / `data_deleted` events,
  with row counts, never content) and **ownership-checked**: a caller can
  only export or delete the account matching their own authenticated
  identity — this is covered by a dedicated regression test
  (`P-SEC-5` in `mcis/backend/__tests__/hardening.test.js`) proving a
  different authenticated user gets `403`, not someone else's data.
- A workspace owner can additionally export/delete an entire **workspace's**
  data (Layer 8 — `P14-1`/`P14-2` in `mcis/backend/__tests__/hardening.test.js`):
  owner-only, refused while an active subscription or running execution
  exists, deletes every layer's business data with no credential, signing
  secret, key hash, or token left anywhere, and leaves exactly one
  content-free audit row behind rather than erasing the audit trail
  entirely.

## What a user cannot currently self-serve

- There's no UI yet for revoking one specific device's access to the
  shared voice-device token independent of every other device using it
  (see `SECURITY.md` and `LIMITATIONS.md`) — revocation today means
  rotating the shared secret for everyone.
- There's no self-serve retention/anonymization UI beyond the full
  export/delete flow above — an operator wanting a different retention
  policy configures it server-side (`services/ops/retentionService.js`).

## Memory / "remembers everything"

The product's core pitch (per-user persistent memory across conversations)
means a user's conversations genuinely inform future answers for that same
user. That memory is scoped per user (never shared across accounts) and
per workspace where workspace scoping applies (`mcis/backend/docs/LAYER2_WORKSPACE_DATA_SCOPING.md`),
and is included in the export/delete flow above like any other stored data.
