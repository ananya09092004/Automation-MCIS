from common import ExecutionAction, ExecutionResult
from execution_gateway import ExecutionGateway


class FakePlatform:
    def execute(self, action):
        return ExecutionResult(True, action.platform, action.action, "Completed")


class FakeEvidence:
    def desktop_screenshot(self, action):
        return f"evidence/{action}.png"


def test_gateway_adds_requested_before_after_evidence():
    gateway = ExecutionGateway(desktop_executor=FakePlatform(), browser_executor=FakePlatform(), evidence_collector=FakeEvidence())
    result = gateway.execute(ExecutionAction("desktop", "read_file", parameters={"capture_evidence": True}))
    assert result.success
    assert result.evidence["artifacts"] == {
        "before": "evidence/before_read_file.png", "after": "evidence/after_read_file.png"
    }
