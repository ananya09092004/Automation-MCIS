"""End-to-end safety boundary checks without touching user files or external services."""

from common import ExecutionAction, ExecutionResult
from execution_gateway import ExecutionGateway


class FakePlatform:
    def __init__(self):
        self.called = []

    def execute(self, action):
        self.called.append(action.action)
        return ExecutionResult(True, action.platform, action.action, "Completed", data={"safe": True})


def _gateway():
    desktop = FakePlatform()
    return ExecutionGateway(desktop_executor=desktop, browser_executor=FakePlatform()), desktop


def test_delete_is_blocked_without_approval_before_platform_execution():
    gateway, desktop = _gateway()
    result = gateway.execute(ExecutionAction("desktop", "delete_file", parameters={"path": "C:/not-used.txt"}))
    assert not result.success
    assert "approval" in result.message.lower()
    assert desktop.called == []


def test_close_and_terminal_actions_are_blocked_without_approval():
    gateway, desktop = _gateway()
    for action in ("close_app", "run_terminal"):
        result = gateway.execute(ExecutionAction("desktop", action))
        assert not result.success
    assert desktop.called == []


def test_approved_safe_action_proceeds_with_state_evidence():
    gateway, desktop = _gateway()
    result = gateway.execute(ExecutionAction("desktop", "read_file", parameters={"path": "C:/safe.txt"}, approval_token="optional"))
    assert result.success
    assert desktop.called == ["read_file"]
    assert result.evidence["state"]["values"]["success"] is True
