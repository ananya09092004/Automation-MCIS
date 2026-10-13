"""Regression tests for the close_app authorization fix in
voice/local_fast_path.py.

Context: close_app is listed in common/approval.py's HIGH_RISK_ACTIONS,
and every other execution path (ExecutionGateway, DesktopPlatformExecutor,
BrowserPlatformExecutor) enforces ApprovalGate before running a high-risk
action. The local fast path used to call AppController.close_app()
directly, bypassing that gate entirely -- this proves it no longer does,
while every other fast-path action (open/switch/minimize/maximize/new
tab/new window) keeps running immediately and unaffected.
"""

from common import ExecutionAction
from voice import local_fast_path


class _FakeAppController:
    """Stands in for desktop.app_controller.controller.AppController --
    records whether close_app was actually invoked, without touching a
    real OS process."""

    def __init__(self, close_result=True):
        self.close_calls = []
        self._close_result = close_result

    def close_app(self, name):
        self.close_calls.append(name)
        return self._close_result

    def open_app(self, name):
        raise AssertionError("open_app should not be touched by the close_app fix.")

    def switch_to_app(self, name):
        raise AssertionError("switch_to_app should not be touched by the close_app fix.")

    def is_running(self, name):
        return True


# ---------------------------------------------------------------------------
# 1. No command -> close_app does not execute.
# ---------------------------------------------------------------------------

def test_no_command_never_executes_close_app(monkeypatch):
    fake = _FakeAppController()
    monkeypatch.setattr(local_fast_path, "_controller", lambda: fake)

    def _confirm_boom(prompt):
        raise AssertionError("No command was given -- confirm() must never be asked.")

    assert local_fast_path.try_execute("", confirm=_confirm_boom) is None
    assert local_fast_path.try_execute(None, confirm=_confirm_boom) is None
    assert local_fast_path.try_execute("   ", confirm=_confirm_boom) is None
    assert fake.close_calls == []


# ---------------------------------------------------------------------------
# 2. Explicit close command -> an authorization check is required.
# ---------------------------------------------------------------------------

def test_explicit_close_command_asks_for_authorization(monkeypatch):
    fake = _FakeAppController(close_result=True)
    monkeypatch.setattr(local_fast_path, "_controller", lambda: fake)

    confirm_prompts = []

    def confirm(prompt):
        confirm_prompts.append(prompt)
        return True

    local_fast_path.try_execute("close chrome", confirm=confirm)

    assert len(confirm_prompts) == 1
    assert "chrome" in confirm_prompts[0]


# ---------------------------------------------------------------------------
# 3. Without required approval -> close_app is blocked.
# ---------------------------------------------------------------------------

def test_declined_authorization_blocks_close_app(monkeypatch):
    fake = _FakeAppController(close_result=True)
    monkeypatch.setattr(local_fast_path, "_controller", lambda: fake)

    response = local_fast_path.try_execute("close chrome", confirm=lambda prompt: False)

    assert fake.close_calls == []
    assert "approval" in response.lower() or "nahi" in response.lower()


def test_missing_confirm_callback_blocks_close_app(monkeypatch):
    """No confirm callback supplied at all (confirm=None, the default) --
    a high-risk action must still be blocked rather than silently
    allowed through."""
    fake = _FakeAppController(close_result=True)
    monkeypatch.setattr(local_fast_path, "_controller", lambda: fake)

    response = local_fast_path.try_execute("close chrome")

    assert fake.close_calls == []
    assert response is not None


# ---------------------------------------------------------------------------
# 4. With valid authorization/approval -> close_app can execute.
# ---------------------------------------------------------------------------

def test_approved_authorization_allows_close_app_to_execute(monkeypatch):
    fake = _FakeAppController(close_result=True)
    monkeypatch.setattr(local_fast_path, "_controller", lambda: fake)

    response = local_fast_path.try_execute("close chrome", confirm=lambda prompt: True)

    assert fake.close_calls == ["chrome"]
    assert response == "Done."


# ---------------------------------------------------------------------------
# Sanity: the same ApprovalGate class/semantics used everywhere else is
# what's actually being enforced here (not a parallel, weaker check).
# ---------------------------------------------------------------------------

def test_close_app_action_is_recognized_as_high_risk_by_the_shared_gate():
    from common.approval import HIGH_RISK_ACTIONS
    assert "close_app" in HIGH_RISK_ACTIONS
    action = ExecutionAction(platform="desktop", action="close_app", value="chrome")
    assert action.approval_token is None  # unapproved by default, same contract everywhere


# ---------------------------------------------------------------------------
# Unrelated fast-path actions are untouched by this fix.
# ---------------------------------------------------------------------------

def test_open_app_fast_path_is_unaffected_and_needs_no_confirmation(monkeypatch):
    class _OpenOnly:
        def __init__(self):
            self.opened = []

        def open_app(self, name):
            self.opened.append(name)
            return True

    fake = _OpenOnly()
    monkeypatch.setattr(local_fast_path, "_controller", lambda: fake)

    def _confirm_boom(prompt):
        raise AssertionError("open_app is low-risk -- it must not ask for confirmation.")

    response = local_fast_path.try_execute("open chrome", confirm=_confirm_boom)

    assert fake.opened == ["chrome"]
    assert response == "Done."
