# Limitations

A plain list of what this product does not do yet, so "is X supported"
has one place to check instead of being discovered by trial and error.
Nothing here is a secret — it's exactly what this pre-launch hardening
pass found and chose not to paper over.

## Platform / execution

- **Desktop and browser automation (Nexus) requires Windows.** UI
  automation, screenshots, and native app control need an interactive
  Windows desktop session. There is no macOS or Linux execution agent.
- **Voice-device identity is shared, not per-device issued.** Every local
  voice client holding the configured `NEXUS_VOICE_DEVICE_TOKEN` is
  treated as one principal for authorization purposes, and there is still
  one shared secret for the whole fleet rather than one credential issued
  per physical device. A *known* individual device's `deviceId` can be
  revoked on its own (`NEXUS_VOICE_DEVICE_REVOKED_IDS`), but if the shared
  secret itself is compromised (rather than one specific known device),
  the only fix is still rotating it for everyone. See `SECURITY.md`.
- **The voice client doesn't re-send a command after a first-time
  permission grant.** If `PERMISSIONS_ENFORCED=true`, a resource outside
  the built-in safe list needs an explicit grant before the agent can use
  it — but today the voice flow doesn't automatically retry the original
  command once that grant happens; the user has to ask again. This is why
  `PERMISSIONS_ENFORCED=false` is a legitimate, supported choice for a
  voice-first deployment rather than a stopgap nobody should actually use.
  See `mcis/backend/docs/SECURITY_FIXES_PRE_LAYER2.md`.

## Billing

- **No automatic proration, mid-cycle upgrade/downgrade billing math, or
  tax calculation.** The billing system (Layer 7/8) handles plan
  assignment, usage metering/quota enforcement, checkout, and webhook-
  driven subscription state — it does not compute prorated charges itself;
  that's whatever your payment provider's own checkout/portal flow does.
- **The personal daily-chat-message cap and the real workspace billing
  system are not connected.** `middleware/dailyLimit.js`'s per-account
  message limit is still hardcoded to the free tier regardless of a
  workspace's real paid plan. See `BILLING.md`.
- **No dunning/retry email sequence** beyond what your payment provider
  sends on its own — a `past_due` subscription gets a configurable grace
  period before lapsing to Free, but this product doesn't send its own
  "your card failed" emails.

## Execution honesty / what's real vs. not

- **The "adversarial test" code-quality pipeline's actual test execution
  runs in an external sandbox (Judge0), not on the backend host.** This is
  the fix for a prior remote-code-execution issue, not a limitation in the
  normal sense — flagged here because it's exactly the kind of thing a
  customer evaluating "does this really execute my code" should be able to
  find written down. A dead, non-sandboxed fake implementation of the same
  function existed in the codebase (never actually wired to any route) and
  was removed during this pass rather than left as a trap for a future
  change.
- **Not every template step that looks automated is backed by a connected,
  real third-party integration.** A connector-shaped step in a workflow
  template only becomes a live call to a real external system once your
  workspace has actually connected that integration; until then the
  template reports the integration as "missing," not as working. There is
  currently no single, consistent customer-facing label distinguishing
  "runs natively," "calls your connected integration," "hits a URL you
  configured yourself," "demo/fixture only," "needs external setup," and
  "not supported" across every execution surface — the underlying
  per-workspace availability check is real and tested, but the labeling
  of *which kind* of execution a given step is isn't unified yet. Treat
  this as an open UX/trust gap worth closing before scaling connector
  usage, not as something already presented dishonestly today.

## Nexus test coverage on non-Windows machines

- Running `py -m pytest -m "not live" -q` on Linux/macOS fails to *collect*
  (not fails, *fails to collect*) a known set of test modules that import
  Windows-only packages (`pywin32`, `pygetwindow`, `pyautogui`) at module
  load time. This is a pre-existing, documented characteristic of the test
  suite, not a sign those modules are broken — they're simply untestable
  outside a Windows environment. Run `--continue-on-collection-errors` to
  get the rest of the suite's results on such a machine, and treat full
  confidence in the Windows-only modules as requiring an actual Windows
  CI runner (not set up in this repo today).
- Separately from the collection errors above, exactly 6 tests *collect*
  but *fail* on a non-Windows, offline sandbox (`169 passed, 6 failed, 90
  deselected, 6 errors` from `--continue-on-collection-errors`). Each was
  re-run individually with a full traceback (final paying-customer launch
  gate pass) rather than assumed from the prior characterization; none is
  a product or security defect:
  - `test_browser_navigation_ssrf_security.py::test_public_url_allowed`
    (all 3 parametrizations) — `socket.getaddrinfo('example.com', None)`
    raises `socket.gaierror: [Errno -2] Name or service not known`: this
    sandbox has no outbound DNS resolution at all for any external
    hostname. `browser/security/url_policy.py`'s fail-closed design
    converts that into `UnsafeNavigationError` ("could not resolve host")
    rather than silently permitting the navigation — the correct safe
    behavior when a hostname can't be resolved, not a bypass. On a host
    with working DNS (a real deployment, or CI with network egress) this
    passes.
  - `test_desktop_controls_unit.py::test_terminal_returns_structured_output_for_a_safe_command`
    — runs `powershell -NoProfile -Command ...`; fails with
    `/bin/sh: 1: powershell: not found` (`return_code=127`). `Terminal
    Controller` executed the command and returned a correctly-structured,
    honest `CommandResult(success=False, return_code=127, ...)` — it
    didn't fail to execute, it correctly reported that a Windows-only
    binary doesn't exist on this Linux sandbox.
  - `test_live_scripts_import_safety.py::test_live_scratch_module_import_performs_no_real_keyboard_input`
    (both parametrizations) — the test's own safety harness
    (`_forbid_real_keyboard_input`) does `import pyautogui` to monkeypatch
    it before importing the module under test; `pyautogui` (Windows-only)
    isn't installed on Linux, so the harness itself can't load. Same root
    cause as the collection errors above, surfacing as a runtime failure
    instead because this particular test file otherwise collects fine.

## Commercial productization pass — known gaps

- **No public (pre-login) pricing page.** `/billing` shows real, honest
  plan data from `GET /billing/plans`, but it's an authenticated app page
  like the rest of the dashboard — a visitor who hasn't signed up yet
  can't see pricing without creating an account first.
- **No standalone STARTER/GROWTH/BUSINESS tier rename.** The real,
  enforced plans are `free`/`pro`/`business`/`enterprise`; they already
  carry the right shape of limits, just not that specific marketing
  naming. Renaming is a product decision, not a code gap.
- **Reports are computed on demand, not stored.** The `reports_generated`
  usage dimension meters report *generation*, not a saved history of past
  reports — there's no report library/scheduling UI yet.
- **The demo/sample data is a single fixed product.** It's enough to
  exercise products, matches, monitoring, a price change, a
  recommendation and the insights/value view end to end, but it isn't a
  rich multi-product showcase.

## Compliance

- **No compliance certification (SOC 2, ISO 27001, HIPAA, PCI-DSS, etc.)
  is claimed anywhere in this codebase or its documentation, because none
  has been obtained.** If you need one for your own go-to-market, treat
  this entire security-hardening pass as useful groundwork, not a
  substitute for an actual audit against that framework.
