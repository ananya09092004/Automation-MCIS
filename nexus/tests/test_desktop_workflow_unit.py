from common import ExecutionResult
from desktop.app_workflow import DesktopAppWorkflow


class FakeExecutor:
    def execute(self, action):
        if action.action == "inspect_screen_state":
            return ExecutionResult(True, "desktop", action.action, "Completed", data={"state": "error", "safe_to_act": False})
        return ExecutionResult(False, "desktop", action.action, "Failed", error="Control vanished")


def test_desktop_workflow_stops_and_reports_safe_recovery():
    result = DesktopAppWorkflow(FakeExecutor()).run([
        {"platform": "desktop", "action": "click_target", "target": {"window_title": "Demo"}},
    ])
    assert not result.success
    assert result.recovery["status"] == "stopped_safely"
    assert result.recovery["screen_state"]["state"] == "error"
