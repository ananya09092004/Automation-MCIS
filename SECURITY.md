# Security

## Reporting

Report vulnerabilities privately to the repository owner (GitHub: `ananya09092004`) —
not in a public issue. Include steps to reproduce and the affected path.

## Model

- **Authentication**: Firebase ID tokens, verified by the backend (`middleware/auth.js`).
  `ALLOW_UNAUTHENTICATED_API` is a development switch and is refused when `NODE_ENV=production`.
- **Authorization**: all tenant access goes through `services/workspaceService.js →
  resolveContext()`. Non-members get 404; roles (owner / admin / member) are enforced on the
  server. Frontends hide buttons for convenience only.
- **Data**: the backend uses the Supabase service-role key, server-side only. Every table in
  `public` has RLS enabled and no anon/authenticated privileges
  (`migrations/20261003_legacy_tables_rls.up.sql`); `scripts/schema-audit.sql` must return 0 rows.
  No browser app contains a Supabase key.
- **Agent actions**: GREEN / YELLOW / RED risk tiers; risky steps wait for an approval with a
  required role, expiry and separation of duties. Emergency stop and firewall per workspace.
  Every decision is audited; execution evidence is stored with sensitive-data redaction.
- **Secrets at rest**: integration credentials and webhook secrets are encrypted
  (`INTEGRATION_ENCRYPTION_KEY`, rotation script). Device tokens are not yet hashed (see LIMITATIONS.md).
- **Desktop devices**: pairing sessions expire after 15 minutes, can be approved once, and the
  token is delivered once. Owners revoke devices from the Nexus console (Settings) or
  `DELETE /api/device/:deviceId`, which also disconnects the live agent.
- **Errors**: clients get generic messages with a request id; details stay in server logs.
- **Secrets in Git**: `node mcis/backend/scripts/secret-scan.js` must report clean. Only
  `.env.example` files (names only) are committed.

## Operator checklist

1. Apply every migration; run `scripts/schema-audit.sql` → 0 rows.
2. `node mcis/backend/scripts/check-config.js` → 0 errors.
3. `ALLOWED_ORIGINS` = exactly your https frontends.
4. Set `NEXUS_DEVICE_TOKEN` on both the backend and every Nexus engine; firewall port 8000.
5. Set `METRICS_TOKEN` (≥ 32 chars) or leave `/metrics` disabled.
6. Run several backend instances only with `MULTI_INSTANCE_EXECUTION=true`.

Known gaps are listed in `LIMITATIONS.md` and `docs/FINAL_LAUNCH_READINESS.md`.
