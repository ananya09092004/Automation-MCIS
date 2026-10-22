# Known limitations

Full ledger: `mcis/backend/docs/LAYER10_LEDGER.md` (58 closed, 11 need external validation,
26 intentionally unsupported, 6 remaining). The remaining items:

| Id | Limitation | Impact | Next step |
|---|---|---|---|
| F-R1 | ~~`nexus/api_server.py` fail-open~~ **Closed:** fails closed (503) without `NEXUS_DEVICE_TOKEN`, constant-time compare, binds `127.0.0.1` by default (`NEXUS_BIND_HOST`), refuses a network bind without a token; loopback-only dev switch `NEXUS_ALLOW_UNAUTHENTICATED_LOCAL` | — | Remote (cloud → desktop) execution still needs a secure tunnel to the engine |
| F-R2 | `requirements.txt` gaps **fixed** (`python-dotenv`, `win10toast` on Windows); a test still imports a non-existent module | Test collection | Fix or remove that import |
| F-R3 | `nexus/screen.png`, `nexus/desktop_test.png` are real desktop screenshots in the public repo | Privacy | Delete; optionally purge history |
| F-R4 | Device tokens in plaintext; no global API rate limit; pairing endpoints unlimited | Defence in depth | Hash tokens; add limits after setting `trust proxy` |
| F-R5 | Dependency advisories (backend 1 critical, CRA chain, firebase → grpc) | Supply chain | Planned major upgrades, not forced |
| F-R6 | No CI / Docker; committed `nexus-layer1-checkpoint.bundle` | Process | Add CI; `git rm --cached` the bundle |

Not configured by default (code exists, needs accounts): payments (Stripe), invitation email,
Slack / GitHub / Google Drive connectors, public webhook delivery.

By design: a desktop step already sent cannot be recalled (cancellation applies between
steps); voice has no workspace concept and writes to the personal workspace; building
workflows and connecting integrations stays in the MCIS app (the Nexus console runs and
monitors them).

Not verified in the final pass: voice / wake word, browser and desktop automation (Windows
only; code unchanged).
