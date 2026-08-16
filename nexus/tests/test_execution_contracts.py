from common import ApprovalGate, ApprovalRequiredError, ExecutionAction, RiskLevel


def test_low_risk_action_needs_no_approval():
    action = ExecutionAction(platform="desktop", action="read_file")
    ApprovalGate().ensure_allowed(action)


def test_high_risk_action_is_blocked_without_token():
    action = ExecutionAction(platform="desktop", action="delete_file", risk=RiskLevel.HIGH)
    try:
        ApprovalGate().ensure_allowed(action)
    except ApprovalRequiredError:
        return
    raise AssertionError("A high-risk action must be blocked without approval.")


def test_approval_token_allows_high_risk_action():
    action = ExecutionAction(
        platform="browser", action="submit", risk=RiskLevel.HIGH, approval_token="test-approved"
    )
    ApprovalGate().ensure_allowed(action)


def test_action_can_be_loaded_from_orchestrator_payload():
    action = ExecutionAction.from_dict({
        "platform": "browser", "action": "fill", "target": {"label": "Email"},
        "value": "person@example.com", "risk": "low",
    })
    assert action.risk is RiskLevel.LOW
    assert action.target["label"] == "Email"
