# Nexus Execution Platform

Nexus is the local execution layer for desktop, browser, perception, and
action-verification work. It receives a structured action from the partner
Brain/orchestrator and either completes it with evidence or returns a safe,
structured failure. It does **not** decide the user's goal, store credentials,
or bypass confirmation for sensitive work.

## Setup (Windows)

```powershell
py -m pip install -r requirements.txt
py -m playwright install
```

Office file creation and verification use standard `.docx`, `.xlsx`, and
`.pptx` formats. Opening a document uses the user's installed default app.
OCR, Windows UI Automation, screenshots, and native desktop control require
an interactive Windows desktop session.

## Safe test commands

Run normal tests first; these should not launch a real browser or desktop app.

```powershell
py -m pytest -m "not live" -q
```

Tests marked `live` intentionally interact only with temporary files and safe
local apps. Run them explicitly after closing unsaved work:

```powershell
py -m pytest -m live -q
```

## Execution contract

The partner orchestrator sends an `ExecutionAction`:

```python
{
  "platform": "desktop",          # desktop or browser
  "action": "read_file",
  "parameters": {"path": "C:/safe/example.txt"},
  "target": {},
  "value": None,
  "approval_token": None
}
```

Every call returns an `ExecutionResult` with `success`, `data`, `evidence`, and
an `error` if it could not proceed. Unsupported actions return a safe failure;
they never fall back to random clicking.

## Safety boundary

An approval token is required for destructive or sensitive actions, including
deleting/moving/renaming/writing files or folders, terminal execution, closing
apps/windows, stopping processes, login, send, submit, booking, and payment.

The browser executor never automatically accepts permissions, consent banners,
payments, final bookings, or sends. `fill_form` fills fields but does not
submit them.

## Supported actions

See [docs/09_supported_actions.md](docs/09_supported_actions.md) for grouped
action names and parameter conventions. The source of truth at runtime is
`common/capabilities.py` (`default_capabilities()`).

## Current verification status

Code-level/unit checks cover action contracts, safe retry, rollback, recovery,
notification history, and perception state detection. Real local acceptance
tests are intentionally kept separate; a feature is only marked verified after
its applicable live test has passed on the target laptop.
