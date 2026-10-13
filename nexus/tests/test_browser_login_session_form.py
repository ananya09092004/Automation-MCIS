from common import ExecutionAction, RiskLevel, issue_approval_token
from browser.platform_executor import BrowserPlatformExecutor
from browser.security.url_policy import BrowserNavigationPolicy


def test_login_form_and_session_state_are_handled_locally(tmp_path):
    page_file = tmp_path / "login.html"
    session_file = tmp_path / "session.json"
    page_file.write_text(
        "<label>User <input aria-label='User'></label><label>Password <input aria-label='Password' type='password'></label>"
        "<button onclick=\"document.body.innerHTML='Signed in'\">Sign in</button>"
        "<label>City <input aria-label='City'></label>", encoding="utf-8"
    )
    # P-SEC-2: file:// is blocked by default; this test serves a local
    # fixture with no real network destination, so it explicitly opts
    # into the relaxed test-only policy (browser/security/url_policy.py).
    executor = BrowserPlatformExecutor(navigation_policy=BrowserNavigationPolicy(allow_file_urls=True))
    try:
        assert executor.execute(ExecutionAction(platform="browser", action="navigate", value=page_file.as_uri(), parameters={"browser_options": {"headless": True}})).success
        login_action = ExecutionAction(
            platform="browser", action="login", risk=RiskLevel.HIGH,
            value={"username": "user", "password": "secret"},
            parameters={"targets": {"username": {"label": "User"}, "password": {"label": "Password"}, "submit": {"role": "button", "name": "Sign in"}}},
        )
        # P-SEC-1: a real token bound to this exact login action, not a
        # bare literal -- "test-approved" would no longer pass the gate.
        login_action.approval_token = issue_approval_token(login_action)
        login = executor.execute(login_action)
        assert login.success, login.error
        saved = executor.execute(ExecutionAction(platform="browser", action="save_session", parameters={"path": str(session_file)}))
        assert saved.success, saved.error
        assert saved.evidence["verified"] is True
    finally:
        executor.stop()
