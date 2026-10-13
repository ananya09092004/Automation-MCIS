from common import ExecutionAction, ExecutionResult
from execution_workflow import ExecutionWorkflow


class FakeGateway:
    def __init__(self, failures_before_success=0):
        self.failures_before_success = failures_before_success
        self.calls = []

    def execute(self, action):
        self.calls.append(action.action)
        success = len(self.calls) > self.failures_before_success
        return ExecutionResult(success, action.platform, action.action, "ok" if success else "temporary failure")


def test_safe_action_retries_and_then_succeeds():
    gateway = FakeGateway(failures_before_success=1)
    result = ExecutionWorkflow(gateway, retry_delay=0).run([
        ExecutionAction(platform="browser", action="navigate", value="https://example.test"),
    ])
    assert result.success
    assert gateway.calls == ["navigate", "navigate"]
    assert result.results[0].evidence["attempt"] == 2


def test_risky_action_is_not_retried_after_failure():
    gateway = FakeGateway(failures_before_success=2)
    result = ExecutionWorkflow(gateway, retry_delay=0).run([
        ExecutionAction(platform="browser", action="submit", approval_token="approved"),
    ])
    assert not result.success
    assert result.failed_step == 0
    assert gateway.calls == ["submit"]
