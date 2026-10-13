from common import ApprovalGate, ApprovalRequiredError, ExecutionAction, RiskLevel, issue_approval_token


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
    # P-SEC-1: a real, action-bound token is required now -- a bare
    # literal like "test-approved" no longer satisfies the gate (see
    # tests/test_approval_binding_security.py for the full regression set).
    action = ExecutionAction(platform="browser", action="submit", risk=RiskLevel.HIGH)
    action.approval_token = issue_approval_token(action)
    ApprovalGate().ensure_allowed(action)


def test_action_can_be_loaded_from_orchestrator_payload():
    action = ExecutionAction.from_dict({
        "platform": "browser", "action": "fill", "target": {"label": "Email"},
        "value": "person@example.com", "risk": "low",
    })
    assert action.risk is RiskLevel.LOW
    assert action.target["label"] == "Email"
