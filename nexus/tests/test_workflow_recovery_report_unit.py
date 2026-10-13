from common import ExecutionResult
from execution_workflow import ExecutionWorkflow


class FailingGateway:
    def execute(self, action):
        return ExecutionResult(False, action.platform, action.action, "Action failed", error="Target disappeared")


def test_workflow_returns_a_clear_safe_stop_report():
    result = ExecutionWorkflow(FailingGateway(), retry_delay=0).run([
        {"platform": "desktop", "action": "read_target"},
    ])
    assert not result.success
    assert result.recovery_report["status"] == "stopped_safely"
    assert result.recovery_report["action"] == "read_target"
