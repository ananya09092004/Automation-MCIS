from common import ExecutionAction
from browser.platform_executor import BrowserPlatformExecutor


def test_browser_executor_fills_a_local_form(tmp_path):
    page_file = tmp_path / "form.html"
    page_file.write_text(
        "<html><head><title>Nexus test</title></head>"
        "<body><label>Email <input aria-label='Email'></label></body></html>",
        encoding="utf-8",
    )

    executor = BrowserPlatformExecutor()
    try:
        opened = executor.execute(ExecutionAction(
            platform="browser",
            action="navigate",
            value=page_file.as_uri(),
            parameters={"browser_options": {"headless": True}},
        ))
        assert opened.success, opened.error

        filled = executor.execute(ExecutionAction(
            platform="browser",
            action="fill",
            target={"label": "Email"},
            value="person@example.com",
        ))
        assert filled.success, filled.error
        assert filled.evidence["verified"] is True
    finally:
        executor.stop()
