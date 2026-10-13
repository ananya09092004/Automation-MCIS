"""Regression tests for the "user-order-only execution" security boundary.

These prove, without touching a real microphone, LLM, browser, or desktop
app, that:

1. No user command means no real-world action is attempted.
2. "type X" executes only the type action.
3. "type X and send" executes type + send, and nothing else -- with the
   high-risk "send" step still gated behind explicit confirmation.
4. An ambiguous / unplannable command never reaches execution.
5. Calling a platform executor directly (bypassing ExecutionGateway
   entirely) is still rejected for an unapproved high-risk action by that
   executor's own ApprovalGate check -- confirming the approval layer is
   enforced at each adapter, not only at the shared gateway.

Existing coverage this complements (left untouched):
- tests/test_execution_contracts.py / test_safety_acceptance_unit.py --
  ApprovalGate and ExecutionGateway-level blocking.
- tests/test_controller_voice_bridge.py -- NexusController planning/retry
  wiring for a single low-risk action and a single high-risk action.
- tests/test_live_scripts_import_safety.py -- zero real input during
  module import/collection.
"""

import json
from types import SimpleNamespace

from common import ExecutionAction, ExecutionResult, RiskLevel, issue_approval_token, verify_approval_token
from controller import NexusController
from voice import local_fast_path


def _fake_llm_response(text):
    message = SimpleNamespace(content=text)
    choice = SimpleNamespace(message=message)
    return SimpleNamespace(choices=[choice])


# ---------------------------------------------------------------------------
# 1. No user command => no real-world action.
# ---------------------------------------------------------------------------

def test_empty_command_never_reaches_local_fast_path_execution(monkeypatch):
    """local_fast_path.try_execute() must return None (defer/no-op) for an
    empty or missing command, and must never touch the real AppController
    or KeyboardController to get there."""

    def _boom():
        raise AssertionError("local fast-path touched a real controller with no command.")

    monkeypatch.setattr(local_fast_path, "_controller", _boom)
    monkeypatch.setattr(local_fast_path, "_keyboard", _boom)

    assert local_fast_path.try_execute("") is None
    assert local_fast_path.try_execute(None) is None
    assert local_fast_path.try_execute("   ") is None


def test_blank_command_to_controller_never_calls_execute_action(monkeypatch):
    """An empty/whitespace-only utterance reaching NexusController must be
    treated as chat (or a no-op), never as a plan to execute."""
    controller = NexusController()

    def _boom(action):
        raise AssertionError(f"execute_action was called with no real command: {action!r}")

    monkeypatch.setattr(controller, "execute_action", _boom)
    monkeypatch.setattr(controller.llm, "ask", lambda command: "nothing to do")

    assert controller.handle("") == "nothing to do"
    assert controller.handle("   ") == "nothing to do"


# ---------------------------------------------------------------------------
# 2. "type X" executes only the type action.
# ---------------------------------------------------------------------------

def test_single_type_command_executes_exactly_one_action(monkeypatch):
    controller = NexusController()
    plan = json.dumps({"actions": [{"platform": "desktop", "action": "type_text", "value": "Hello"}]})
    monkeypatch.setattr(
        controller.llm.client.chat.completions, "create",
        lambda **kwargs: _fake_llm_response(plan),
    )

    calls = []

    def fake_execute(action):
        calls.append(dict(action))
        return ExecutionResult(True, "desktop", action["action"], "Completed")

    monkeypatch.setattr(controller, "execute_action", fake_execute)

    controller.handle("notepad mein Hello type kardo")

    assert len(calls) == 1
    assert calls[0]["action"] == "type_text"


# ---------------------------------------------------------------------------
# 3. "type X and <high-risk step>" executes both and nothing else, with
#    the high-risk step still gated behind explicit confirmation.
#
#    ("send"/"submit" are the security requirement's own example names,
#    but neither is a capability this planner can currently emit --
#    common/approval.py's HIGH_RISK_ACTIONS set lists them for a future
#    action, while common/contracts.py's supported-action catalog has no
#    matching entry yet. close_app is used here instead: it is a real,
#    catalog-supported action that IS in HIGH_RISK_ACTIONS today, so the
#    type+confirm-gated-second-step behavior is exercised for real rather
#    than asserted against an action that would never survive planning.)
# ---------------------------------------------------------------------------

def test_type_and_high_risk_step_executes_both_and_only_both_actions(monkeypatch):
    calls = []

    def fake_execute(action):
        calls.append(dict(action))
        if action["action"] == "close_app" and "approval_token" not in action:
            return ExecutionResult(False, "desktop", "close_app", "Action blocked pending user approval.")
        return ExecutionResult(True, action.get("platform", "desktop"), action["action"], "Completed")

    confirmations = []

    def confirm(prompt):
        confirmations.append(prompt)
        return True

    controller = NexusController(confirm_callback=confirm)
    plan = json.dumps({"actions": [
        {"platform": "desktop", "action": "type_text", "value": "Hello"},
        {"platform": "desktop", "action": "close_app", "value": "notepad"},
    ]})
    monkeypatch.setattr(
        controller.llm.client.chat.completions, "create",
        lambda **kwargs: _fake_llm_response(plan),
    )
    monkeypatch.setattr(controller, "execute_action", fake_execute)

    controller.handle("Hello type karo aur notepad band kardo")

    # type_text runs once; close_app is attempted, blocked, confirmed,
    # then retried -- exactly 3 execute_action calls, no invented 4th
    # action and nothing beyond the two planned steps.
    assert [call["action"] for call in calls] == ["type_text", "close_app", "close_app"]
    assert len(confirmations) == 1
    # P-SEC-1: the retried call carries a real token, freshly minted for
    # THIS close_app action at the moment of confirmation -- not a fixed
    # literal that would equally "approve" any other high-risk action.
    assert calls[2]["approval_token"]
    assert calls[2]["approval_token"] != "user_voice_confirmed"
    assert verify_approval_token(calls[2]["approval_token"], calls[2], consume=False)


# ---------------------------------------------------------------------------
# 4. An ambiguous command does not execute.
# ---------------------------------------------------------------------------

def test_ambiguous_command_never_calls_execute_action(monkeypatch):
    controller = NexusController()
    # LLM signals it could not confidently plan a safe action.
    plan = json.dumps({"actions": []})
    monkeypatch.setattr(
        controller.llm.client.chat.completions, "create",
        lambda **kwargs: _fake_llm_response(plan),
    )
    monkeypatch.setattr(controller.llm, "ask", lambda command: "too vague to act on")

    def _boom(action):
        raise AssertionError(f"execute_action was called for an ambiguous command: {action!r}")

    monkeypatch.setattr(controller, "execute_action", _boom)

    response = controller.handle("notepad ke baare mein kya khayal hai")
    assert response == "too vague to act on"


# ---------------------------------------------------------------------------
# 5. Unauthorized direct executor invocation is rejected by the existing
#    security layer (independent of ExecutionGateway).
# ---------------------------------------------------------------------------

def test_browser_platform_executor_rejects_unapproved_high_risk_action_directly():
    """BrowserPlatformExecutor.execute() enforces its own ApprovalGate
    check before doing anything else -- calling it directly, with no
    ExecutionGateway in front of it, must still block an unapproved
    high-risk action, and must never start a browser/page to do it."""
    from browser.platform_executor import BrowserPlatformExecutor

    class _NoBrowserAllowed:
        page = None

        def start(self, *args, **kwargs):
            raise AssertionError("A blocked high-risk action must never start a real browser.")

    executor = BrowserPlatformExecutor(controller=_NoBrowserAllowed())

    result = executor.execute(ExecutionAction(platform="browser", action="login", risk=RiskLevel.HIGH))

    assert not result.success
    assert "approval" in (result.error or result.message or "").lower()


def test_browser_platform_executor_allows_approved_high_risk_action_directly():
    """Same direct-invocation path, but WITH a valid approval token --
    proves the gate isn't simply blocking everything."""
    from browser.platform_executor import BrowserPlatformExecutor

    class _FakePage:
        url = "about:blank"

        def title(self):
            return ""

    class _FakeController:
        def __init__(self):
            self.page = _FakePage()
            self.started = False

        def start(self, *args, **kwargs):
            self.started = True

    fake_controller = _FakeController()
    executor = BrowserPlatformExecutor(controller=fake_controller)

    action = ExecutionAction(
        platform="browser", action="login", risk=RiskLevel.HIGH,
        value={"username": "u", "password": "p"},
        parameters={"targets": {"username": {"selector": "#u"}, "password": {"selector": "#p"}, "submit": {"selector": "#s"}}},
    )
    # P-SEC-1: a bare literal like "approved" no longer satisfies the
    # gate -- a real token bound to this exact action is required.
    action.approval_token = issue_approval_token(action)

    result = executor.execute(action)

    # Login itself will fail against a fake page with no real locators,
    # but the point of this test is narrower: an approved high-risk
    # action is allowed PAST the approval gate (it reaches real
    # execution instead of being short-circuited as "pending approval").
    assert result.message != "Action blocked pending user approval."
