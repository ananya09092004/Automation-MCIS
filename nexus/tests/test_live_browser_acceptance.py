"""Safe local browser acceptance test; no external site, account, money, or email is used."""

import functools
import http.server
import threading

import pytest

from browser.platform_executor import BrowserPlatformExecutor
from common import ExecutionAction


@pytest.fixture
def local_demo_server():
    from pathlib import Path
    root = Path(__file__).parents[1] / "demo" / "browser_demo"
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(root))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        thread.join(timeout=3)


def _action(name, **kwargs):
    return ExecutionAction(platform="browser", action=name, **kwargs)


@pytest.mark.live
def test_safe_local_browser_research_form_files_login_and_recovery(local_demo_server, tmp_path):
    pytest.importorskip("playwright")
    executor = BrowserPlatformExecutor()
    options = {"browser_options": {"browser": "chromium", "headless": True}}
    try:
        assert executor.execute(_action("navigate", value=local_demo_server, parameters=options)).success
        assert executor.execute(_action("dismiss_safe_popup", parameters=options)).success
        tables = executor.execute(_action("read_tables", parameters=options))
        assert tables.success and tables.data[0][1] == ["Nova Lite", "2000", "4.1"]
        assert executor.execute(_action("next_page", parameters=options)).success
        assert "Nova Max" in executor.execute(_action("read_text", target={"selector": "#options"}, parameters=options)).data
        form = executor.execute(_action("fill_form", value=[
            {"target": {"selector": "#full-name"}, "value": "Nexus"},
            {"target": {"selector": "#email"}, "value": "nexus@example.test"},
        ], parameters=options))
        assert form.success
        assert executor.controller.page.locator("#form-status").inner_text() == "Form has not been submitted"
        upload = tmp_path / "upload.txt"; upload.write_text("safe upload", encoding="utf-8")
        assert executor.execute(_action("upload", target={"selector": "#upload"}, value=str(upload), parameters=options)).success
        download = executor.execute(_action("download", target={"selector": "#download"}, parameters={**options, "directory": str(tmp_path)}))
        assert download.success
        login = executor.execute(_action("login", value={"username": "nexus", "password": "not-a-real-password"}, approval_token="local-test-approved", parameters={**options, "targets": {"username": {"selector": "#username"}, "password": {"selector": "#password"}, "submit": {"selector": "#login-form button"}}}))
        assert login.success
        session = tmp_path / "session.json"
        assert executor.execute(_action("save_session", parameters={**options, "path": str(session)})).success
        assert executor.execute(_action("load_session", value=str(session), parameters=options)).success
        restored = executor.execute(_action("navigate", value=local_demo_server, parameters={**options, "expected_text": "Logged in as nexus"}))
        assert restored.success and restored.evidence["verified"]
    finally:
        executor.stop()
