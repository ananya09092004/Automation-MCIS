from common import ExecutionAction, RiskLevel
from browser.platform_executor import BrowserPlatformExecutor


def test_login_form_and_session_state_are_handled_locally(tmp_path):
    page_file = tmp_path / "login.html"
    session_file = tmp_path / "session.json"
    page_file.write_text(
        "<label>User <input aria-label='User'></label><label>Password <input aria-label='Password' type='password'></label>"
        "<button onclick=\"document.body.innerHTML='Signed in'\">Sign in</button>"
        "<label>City <input aria-label='City'></label>", encoding="utf-8"
    )
    executor = BrowserPlatformExecutor()
    try:
        assert executor.execute(ExecutionAction(platform="browser", action="navigate", value=page_file.as_uri(), parameters={"browser_options": {"headless": True}})).success
        login = executor.execute(ExecutionAction(
            platform="browser", action="login", risk=RiskLevel.HIGH, approval_token="test-approved",
            value={"username": "user", "password": "secret"},
            parameters={"targets": {"username": {"label": "User"}, "password": {"label": "Password"}, "submit": {"role": "button", "name": "Sign in"}}},
        ))
        assert login.success, login.error
        saved = executor.execute(ExecutionAction(platform="browser", action="save_session", parameters={"path": str(session_file)}))
        assert saved.success, saved.error
        assert saved.evidence["verified"] is True
    finally:
        executor.stop()
