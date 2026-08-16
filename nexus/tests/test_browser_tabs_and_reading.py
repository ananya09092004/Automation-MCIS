from common import ExecutionAction
from browser.platform_executor import BrowserPlatformExecutor


def test_browser_can_open_a_tab_and_read_visible_text(tmp_path):
    page_file = tmp_path / "page.html"
    page_file.write_text("<h1>Shopping comparison</h1><p id='price'>₹999</p>", encoding="utf-8")
    executor = BrowserPlatformExecutor()
    try:
        first = executor.execute(ExecutionAction(
            platform="browser", action="navigate", value=page_file.as_uri(),
            parameters={"browser_options": {"headless": True}},
        ))
        assert first.success, first.error
        read = executor.execute(ExecutionAction(
            platform="browser", action="read_text", target={"selector": "#price"},
        ))
        assert read.success, read.error
        assert read.data == "₹999"
        tab = executor.execute(ExecutionAction(platform="browser", action="new_tab", value=page_file.as_uri()))
        assert tab.success, tab.error
        assert tab.data == 1
        assert executor.execute(ExecutionAction(platform="browser", action="switch_tab", value=0)).success
    finally:
        executor.stop()
