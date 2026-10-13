import pytest

from common import ExecutionAction
from browser.platform_executor import BrowserPlatformExecutor
from browser.security.url_policy import BrowserNavigationPolicy


@pytest.mark.live
def test_real_browser_waits_for_a_delayed_local_page_element(tmp_path):
    page_file = tmp_path / "delayed.html"
    page_file.write_text("<script>setTimeout(()=>document.body.innerHTML='<button>Ready</button>',300)</script>", encoding="utf-8")
    # P-SEC-2: file:// is blocked by default; explicit test-only opt-in.
    executor = BrowserPlatformExecutor(navigation_policy=BrowserNavigationPolicy(allow_file_urls=True))
    try:
        assert executor.execute(ExecutionAction(platform="browser", action="navigate", value=page_file.as_uri(), parameters={"browser_options": {"headless": True}})).success
        result = executor.execute(ExecutionAction(platform="browser", action="wait_for", target={"role": "button", "name": "Ready"}, parameters={"timeout": 3000}))
        assert result.success, result.error
    finally:
        executor.stop()
