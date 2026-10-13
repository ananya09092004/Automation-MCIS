"""Unit tests for the run_terminal timeout CLAMP (P1.8 follow-up).

Context: desktop/executor/router.py's run_terminal branch previously
passed action.get("timeout_seconds") straight through to
TerminalController.run() with no validation. That value originates
from an ExecutionAction's `parameters` dict, which is attacker/
planning-influenced the same way controller.py's approval_token/risk
stripping already treats LLM-produced action payloads as untrusted
(see controller.py's comment on that). Without a ceiling, a planned or
injected payload could simply ASK for a much larger timeout_seconds
(e.g. 999999) instead of omitting it, defeating TerminalController's
own bounded-timeout fix (P1.8) by request rather than by omission.

These tests are deliberately split into two layers:

  1. Direct tests of router._resolve_terminal_timeout() -- a pure
     function, no I/O, no subprocess, no real desktop controllers.
  2. An integration test through DesktopPlatformExecutor (the real
     ApprovalGate + the real ActionRouter.execute() dispatch, but with
     TerminalController swapped for an in-memory fake) proving the
     clamp is actually applied at the call site AND that approval
     gating for run_terminal is completely unaffected by this change.

Nothing here constructs the real ActionRouter via its normal
`ActionRouter()` constructor (which would also build MouseController/
KeyboardController/WindowManager/etc. -- real-device controllers this
CI environment cannot construct, per requirements-ci.txt). Instead a
bare instance is built via `object.__new__` with only `.terminal`
stubbed, since the run_terminal branch only ever touches
`self.terminal`. No real shell command, subprocess, or desktop/browser
automation runs anywhere in this file -- this is not a `live` test.
"""

import math
import sys
import types

# desktop/executor/router.py imports several real-device controllers
# (AppController, MouseController, KeyboardController, WindowManager,
# ScreenshotController) that themselves import platform-specific
# packages -- pygetwindow, pyautogui, mss -- deliberately left out of
# requirements-ci.txt (see that file's own comment) because they only
# install/import on a real Windows/display machine. MERELY IMPORTING
# desktop.executor.router -- regardless of what's actually called --
# transitively requires those five packages, same as every other
# desktop-stack test module in this suite that needs a real device.
#
# This fix and its test are about a pure function (the timeout clamp)
# plus the run_terminal dispatch branch, neither of which touches any
# of those five controllers. So, consistent with the sys.modules
# injection pattern already used in
# test_voice_main_crash_recovery_unit.py for an unavailable package,
# each of the five import targets is stubbed with a minimal fake
# module/class here -- just enough for router.py's own top-level
# `from X import Y` lines to succeed -- before router.py is imported.
# Nothing in this file ever constructs or calls any of these five real
# classes; ActionRouter instances below are built via `__new__` with
# only `.terminal` (a fake, see below) ever set.
_FAKE_DEVICE_MODULES = {
    "desktop.app_controller.controller": "AppController",
    "desktop.mouse.controller": "MouseController",
    "desktop.keyboard.controller": "KeyboardController",
    "desktop.window_manager.manager": "WindowManager",
    "desktop.screenshot.controller": "ScreenshotController",
}
for _mod_name, _cls_name in _FAKE_DEVICE_MODULES.items():
    if _mod_name not in sys.modules:
        _fake_module = types.ModuleType(_mod_name)
        setattr(_fake_module, _cls_name, type(_cls_name, (), {}))
        sys.modules[_mod_name] = _fake_module

from common import ApprovalGate, ExecutionAction, issue_approval_token  # noqa: E402
from desktop.executor.router import (  # noqa: E402
    ActionRouter,
    DEFAULT_TERMINAL_TIMEOUT_SECONDS,
    MAX_TERMINAL_TIMEOUT_SECONDS,
    _resolve_terminal_timeout,
)
from desktop.platform_executor import DesktopPlatformExecutor  # noqa: E402


class _FakeTerminal:
    """Records exactly what ActionRouter asked it to run, does nothing real."""

    def __init__(self):
        self.calls = []

    def run(self, command, cwd=None, timeout_seconds=None):
        self.calls.append({"command": command, "cwd": cwd, "timeout_seconds": timeout_seconds})
        return _FakeCommandResult()


class _FakeCommandResult:
    success = True
    return_code = 0
    stdout = "ok"
    stderr = ""
    timed_out = False


def _bare_router_with_fake_terminal():
    """ActionRouter with every real controller skipped except .terminal."""
    router = ActionRouter.__new__(ActionRouter)
    router.terminal = _FakeTerminal()
    return router, router.terminal


# ---------------------------------------------------------------------
# 1. Direct unit tests of the clamp function itself
# ---------------------------------------------------------------------

def test_normal_timeout_within_bounds_is_preserved():
    assert _resolve_terminal_timeout(10) == 10
    assert _resolve_terminal_timeout(45.5) == 45.5
    # The existing default itself must round-trip unchanged.
    assert _resolve_terminal_timeout(DEFAULT_TERMINAL_TIMEOUT_SECONDS) == DEFAULT_TERMINAL_TIMEOUT_SECONDS


def test_timeout_above_the_maximum_is_clamped_down_to_it():
    assert _resolve_terminal_timeout(999999) == MAX_TERMINAL_TIMEOUT_SECONDS
    assert _resolve_terminal_timeout(MAX_TERMINAL_TIMEOUT_SECONDS + 0.01) == MAX_TERMINAL_TIMEOUT_SECONDS
    # Exactly at the ceiling is allowed through unchanged (not reduced further).
    assert _resolve_terminal_timeout(MAX_TERMINAL_TIMEOUT_SECONDS) == MAX_TERMINAL_TIMEOUT_SECONDS


def test_invalid_or_nonpositive_values_fall_back_to_the_safe_default():
    invalid_values = [
        None,                # missing entirely
        "",                  # empty string
        "not-a-number",      # non-numeric string
        0,                   # zero
        -5,                  # negative
        -0.001,              # negative float
        float("nan"),        # NaN
        float("inf"),        # infinite -- would otherwise defeat the clamp entirely
        float("-inf"),
        [1, 2, 3],           # wrong type entirely
        {"nested": True},    # wrong type entirely
    ]
    for value in invalid_values:
        assert _resolve_terminal_timeout(value) == DEFAULT_TERMINAL_TIMEOUT_SECONDS, (
            f"expected safe fallback for invalid timeout_seconds={value!r}"
        )


def test_the_default_itself_is_sane_and_within_the_maximum():
    # Sanity check on the constants' own relationship, so a future edit
    # to either constant can't silently make the "safe fallback" value
    # itself exceed the ceiling it's supposed to respect.
    assert 0 < DEFAULT_TERMINAL_TIMEOUT_SECONDS <= MAX_TERMINAL_TIMEOUT_SECONDS
    assert math.isfinite(MAX_TERMINAL_TIMEOUT_SECONDS)


# ---------------------------------------------------------------------
# 2. Router-level integration: the clamp is actually applied at the
#    run_terminal call site, and approval gating is untouched.
# ---------------------------------------------------------------------

def test_router_passes_the_default_through_unchanged_when_omitted():
    router, terminal = _bare_router_with_fake_terminal()
    router.execute({"action": "run_terminal", "command": "echo nexus-ok"})
    assert terminal.calls[0]["timeout_seconds"] == DEFAULT_TERMINAL_TIMEOUT_SECONDS
    assert terminal.calls[0]["command"] == "echo nexus-ok"


def test_router_clamps_a_malicious_oversized_timeout_before_calling_terminal_run():
    router, terminal = _bare_router_with_fake_terminal()
    # Simulated manipulated/planned payload asking for an effectively
    # unbounded run -- this must never reach TerminalController as-is.
    router.execute({"action": "run_terminal", "command": "echo nexus-ok", "timeout_seconds": 999999})
    assert terminal.calls[0]["timeout_seconds"] == MAX_TERMINAL_TIMEOUT_SECONDS
    assert terminal.calls[0]["timeout_seconds"] < 999999


def test_router_falls_back_safely_for_a_malformed_timeout_value():
    router, terminal = _bare_router_with_fake_terminal()
    router.execute({"action": "run_terminal", "command": "echo nexus-ok", "timeout_seconds": "forever"})
    assert terminal.calls[0]["timeout_seconds"] == DEFAULT_TERMINAL_TIMEOUT_SECONDS


def test_run_terminal_still_requires_approval_regardless_of_timeout_seconds():
    # Full path through the real ApprovalGate (default validator) and
    # the real ActionRouter.execute() dispatch -- only TerminalController
    # itself is faked. Proves this fix did not weaken, bypass, or
    # otherwise touch the existing HIGH_RISK_ACTIONS approval
    # requirement for run_terminal.
    router, terminal = _bare_router_with_fake_terminal()
    executor = DesktopPlatformExecutor(approval_gate=ApprovalGate(), router=router)

    # No approval_token at all -- even with an "innocent-looking" small
    # timeout, this must still be blocked before ActionRouter (and
    # therefore the fake terminal) is ever reached.
    unapproved = ExecutionAction(
        platform="desktop", action="run_terminal",
        parameters={"command": "echo nexus-ok", "timeout_seconds": 5},
    )
    result = executor.execute(unapproved)
    assert result.success is False
    assert "approval" in (result.error or result.message).lower()
    assert terminal.calls == [], "run_terminal must not execute at all without approval"

    # A malicious oversized timeout_seconds ALSO cannot buy its way
    # around approval -- still blocked, regardless of the value.
    unapproved_malicious_timeout = ExecutionAction(
        platform="desktop", action="run_terminal",
        parameters={"command": "echo nexus-ok", "timeout_seconds": 10_000_000},
    )
    result2 = executor.execute(unapproved_malicious_timeout)
    assert result2.success is False
    assert terminal.calls == [], "an oversized timeout_seconds must not grant approval it doesn't have"

    # Only once a real, action-bound approval_token is present does
    # execution proceed -- and even then, the oversized timeout_seconds
    # is clamped, never honored as-is. (P-SEC-1: a bare literal like
    # "user_confirmed" no longer satisfies the gate -- see
    # tests/test_approval_binding_security.py for the full regression set.)
    approved_malicious_timeout = ExecutionAction(
        platform="desktop", action="run_terminal",
        parameters={"command": "echo nexus-ok", "timeout_seconds": 10_000_000},
    )
    approved_malicious_timeout.approval_token = issue_approval_token(approved_malicious_timeout)
    result3 = executor.execute(approved_malicious_timeout)
    assert result3.success is True
    assert len(terminal.calls) == 1
    assert terminal.calls[0]["timeout_seconds"] == MAX_TERMINAL_TIMEOUT_SECONDS
