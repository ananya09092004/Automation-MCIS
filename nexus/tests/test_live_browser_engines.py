"""Safe local smoke coverage for installed Edge and Playwright Firefox."""

import pytest

from browser.platform_executor import BrowserPlatformExecutor
from browser.security.url_policy import BrowserNavigationPolicy
from common import ExecutionAction


@pytest.mark.live
@pytest.mark.parametrize("browser", ["edge", "firefox"])
def test_nexus_can_read_a_local_page_in_each_supported_engine(tmp_path, browser):
    pytest.importorskip("playwright")
    page = tmp_path / "engine-demo.html"
    page.write_text("<title>Nexus engine</title><h1>Engine-ready</h1>", encoding="utf-8")
    # P-SEC-2: file:// is blocked by default; explicit test-only opt-in.
    executor = BrowserPlatformExecutor(navigation_policy=BrowserNavigationPolicy(allow_file_urls=True))
    try:
        result = executor.execute(ExecutionAction(
            platform="browser", action="navigate", value=page.as_uri(),
            parameters={"browser_options": {"browser": browser, "headless": True}, "expected_text": "Engine-ready"},
        ))
        if not result.success and ("Executable doesn't exist" in (result.error or "") or "channel" in (result.error or "")):
            pytest.skip(f"{browser} is not available on this laptop: {result.error}")
        assert result.success, result.error
        assert result.evidence["verified"]
    finally:
        executor.stop()
