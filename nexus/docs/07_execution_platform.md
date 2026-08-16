# Execution Platform Contract

The Brain sends one `ExecutionAction` at a time to `ExecutionGateway`.

```json
{
  "platform": "browser",
  "action": "fill",
  "target": {"label": "Email"},
  "value": "person@example.com",
  "risk": "low"
}
```

Supported platforms are `desktop` and `browser`. Every response is an
`ExecutionResult` with success status, a message, returned data, and evidence.

High-risk actions such as delete, move, terminal execution, send, submit,
booking, payment, and login are blocked until the Security platform supplies
a valid approval token. This platform validates the token through an injected
approval validator; it never creates, stores, or logs credentials or OTPs.

## Verification

Browser fill actions confirm the field value. Downloads confirm that a
non-empty file was saved. Desktop operations return structured results and
can add evidence through the `ScreenObserver` OCR fallback. The next step is
to add app-specific verification rules through the same contract.
