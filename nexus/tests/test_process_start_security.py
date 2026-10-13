"""D1 (security hardening, pre-launch): start_process / restart_process
run an arbitrary caller-supplied shell command via
desktop/process_manager/controller.py's ProcessManager.start()
(subprocess.Popen(command, shell=True)) -- the exact same shell=True
exposure as run_terminal, just fire-and-forget (launch and detach)
rather than wait-for-output.

These two action names were missing entirely from
common/approval.py's HIGH_RISK_ACTIONS (and from
backend-routing/riskModel.js's RED tier on the MCIS backend side,
covered separately in that repo's own test suite) -- meaning a plan
could launch ANY shell command via start_process/restart_process with
no approval token required at all, the same unauthorized-command-
execution gap B1 closed for run_terminal, just left open on these two
sibling actions.

This file proves, without spawning any real process (a fake router is
injected into DesktopPlatformExecutor so these tests never touch
subprocess.Popen), that the fix closes the gap using the SAME
HMAC-bound approval mechanism already proven for run_terminal/
delete_file/etc in test_approval_binding_security.py and
test_authorization_boundary.py -- not a new, separate mechanism.
"""

import sys
import types

from common import ExecutionAction, ExecutionResult, RiskLevel, issue_approval_token
from common.approval import HIGH_RISK_ACTIONS, ApprovalRequiredError

# desktop/platform_executor.py's top-level `from desktop.executor.router
# import ActionRouter` transitively imports five real-device controllers
# (AppController -> WindowManager -> pygetwindow, plus Mouse/Keyboard/
# Screenshot's own platform-specific packages) that are deliberately
# left out of requirements-ci.txt and only import on a real Windows/
# display machine -- the same gap test_terminal_timeout_clamp_unit.py's
# own comment documents, reusing its exact sys.modules stub here. This
# file never constructs a real ActionRouter (a _RecordingRouter fake is
# injected via DesktopPlatformExecutor's `router=` param instead), so
# stubbing just enough for the `from X import Y` lines to succeed is
# safe -- nothing in this file ever touches these five real classes.
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


class _RecordingRouter:
    """Stands in for ActionRouter -- records whether the underlying
    shell command would have been dispatched, without ever actually
    calling subprocess.Popen."""

    def __init__(self):
        self.calls = []

    def execute(self, payload):
        self.calls.append(payload)
        return ExecutionResult(True, "desktop", payload["action"], "Completed", data={"pid": 4242})


def _make_executor():
    from desktop.platform_executor import DesktopPlatformExecutor

    router = _RecordingRouter()
    executor = DesktopPlatformExecutor(router=router)
    return executor, router


def test_start_process_and_restart_process_are_classified_high_risk():
    assert "start_process" in HIGH_RISK_ACTIONS
    assert "restart_process" in HIGH_RISK_ACTIONS


def test_start_process_without_approval_is_denied_and_never_reaches_the_router():
    executor, router = _make_executor()
    action = ExecutionAction(platform="desktop", action="start_process", value="calc.exe",
                              target={}, parameters={"command": "calc.exe"})

    result = executor.execute(action)

    assert result.success is False
    assert "Approval is required" in (result.error or "")
    assert router.calls == [], "an unapproved start_process must never reach the process manager"


def test_restart_process_without_approval_is_denied_and_never_reaches_the_router():
    executor, router = _make_executor()
    action = ExecutionAction(platform="desktop", action="restart_process", value="notepad.exe",
                              target={}, parameters={"process_name": "notepad", "command": "notepad.exe"})

    result = executor.execute(action)

    assert result.success is False
    assert router.calls == []


def test_start_process_with_a_token_minted_for_a_different_command_is_denied():
    """Command substitution: a token valid for "calc.exe" must not
    authorize launching "powershell.exe -enc <base64>" instead -- this
    is exactly the attack B1's action-binding (not just "a token
    exists") was built to stop."""
    executor, router = _make_executor()
    approved_action = {"platform": "desktop", "action": "start_process", "value": "calc.exe",
                        "target": {}, "parameters": {"command": "calc.exe"}}
    token = issue_approval_token(approved_action)

    attack = ExecutionAction(platform="desktop", action="start_process",
                              value="powershell.exe -enc AAAA", target={},
                              parameters={"command": "powershell.exe -enc AAAA"},
                              approval_token=token)

    result = executor.execute(attack)

    assert result.success is False
    assert router.calls == [], "a token minted for a different command must not authorize this one"


def test_start_process_with_the_exact_approved_command_is_allowed():
    executor, router = _make_executor()
    action_dict = {"platform": "desktop", "action": "start_process", "value": "calc.exe",
                    "target": {}, "parameters": {"command": "calc.exe"}}
    token = issue_approval_token(action_dict)

    action = ExecutionAction(platform="desktop", action="start_process", value="calc.exe",
                              target={}, parameters={"command": "calc.exe"}, approval_token=token)

    result = executor.execute(action)

    assert result.success is True
    assert len(router.calls) == 1
    assert router.calls[0]["command"] == "calc.exe"


def test_restart_process_with_the_exact_approved_command_is_allowed():
    executor, router = _make_executor()
    action_dict = {"platform": "desktop", "action": "restart_process", "value": "notepad.exe",
                    "target": {}, "parameters": {"process_name": "notepad", "command": "notepad.exe"}}
    token = issue_approval_token(action_dict)

    action = ExecutionAction(platform="desktop", action="restart_process", value="notepad.exe",
                              target={}, parameters={"process_name": "notepad", "command": "notepad.exe"},
                              approval_token=token)

    result = executor.execute(action)

    assert result.success is True
    assert len(router.calls) == 1


def test_start_process_with_an_llm_injected_literal_token_is_denied():
    """Mirrors test_authorization_boundary.py / test_approval_binding_
    security.py's coverage for other high-risk actions: an arbitrary
    non-empty string (what a prompt-injected or LLM-hallucinated
    "approval_token" would look like) is not a valid token."""
    executor, router = _make_executor()
    action = ExecutionAction(platform="desktop", action="start_process", value="calc.exe",
                              target={}, parameters={"command": "calc.exe"},
                              approval_token="approved")

    result = executor.execute(action)

    assert result.success is False
    assert router.calls == []


def test_start_process_approval_gate_raises_directly_without_a_platform_executor():
    """Same boundary proven at the ApprovalGate level directly (not
    just through DesktopPlatformExecutor's try/except wrapping) --
    mirrors test_authorization_boundary.py's style for other actions."""
    from common import ApprovalGate

    gate = ApprovalGate()
    action = ExecutionAction(platform="desktop", action="start_process", value="calc.exe",
                              target={}, parameters={"command": "calc.exe"})

    try:
        gate.ensure_allowed(action)
        assert False, "expected ApprovalRequiredError"
    except ApprovalRequiredError:
        pass
