from common import ExecutionAction
from browser.platform_executor import BrowserPlatformExecutor


def test_browser_inspection_returns_visible_page_controls(tmp_path):
    page_file = tmp_path / "shop.html"
    page_file.write_text(
        "<title>Headphones</title><h1>Wireless Headphones</h1>"
        "<input aria-label='Search products'><button>Add to cart</button>"
        "<a href='#reviews'>Reviews</a>",
        encoding="utf-8",
    )
    executor = BrowserPlatformExecutor()
    try:
        opened = executor.execute(ExecutionAction(
            platform="browser", action="navigate", value=page_file.as_uri(),
            parameters={"browser_options": {"headless": True}},
        ))
        assert opened.success, opened.error
        snapshot = executor.execute(ExecutionAction(platform="browser", action="inspect_page"))
        assert snapshot.success, snapshot.error
        assert "Wireless Headphones" in snapshot.data["visible_text"]
        assert {element["name"] for element in snapshot.data["elements"]} >= {"Search products", "Add to cart", "Reviews"}
    finally:
        executor.stop()
