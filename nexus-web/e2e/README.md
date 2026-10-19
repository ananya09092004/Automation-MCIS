# Nexus web — live end-to-end test

Renders the real Nexus UI (jsdom) with the real API client against a **running**
MCIS backend and a real database. Nothing is mocked except the browser.

```bash
NEXUS_E2E_API_URL=http://localhost:5051 \
NEXUS_E2E_OWNER_TOKEN=<Firebase ID token of user A> \
NEXUS_E2E_MEMBER_TOKEN=<Firebase ID token of user B> \
npm run test:e2e
```

- Use two **test** accounts with verified emails (invitations require it).
- Tokens can come from real Firebase test users or from the Firebase Auth
  emulator (backend started with `FIREBASE_AUTH_EMULATOR_HOST`).
- The test creates a new team workspace for user A, starts one real task,
  invites user B, toggles the emergency stop on and off, and checks role
  gating and workspace isolation. It never deletes anything.
- The backend must allow the request origin, or be called server-to-server
  (jsdom's fetch sends no `Origin` header).
