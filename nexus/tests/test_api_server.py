"""Tests for the HTTP bridge (api_server.py) that lets the Node.js
backend call ExecutionGateway over HTTP. ExecutionGateway itself is
mocked -- these tests only verify the HTTP request/response wiring, not
real browser/desktop execution (that's covered by the platform-specific
test suites).
"""
import sys
from types import SimpleNamespace

import execution_gateway as eg_module


class _FakeResult:
    def __init__(self, success=True, platform="desktop", action="open_app",
                 message="Completed", data=None, error=None, evidence=None):
        self.success = success
        self.platform = platform
        self.action = action
        self.message = message
        self.data = data
        self.error = error
        self.evidence = evidence or {}


class _FakeGateway:
    def __init__(self):
        self.calls = []

    def execute(self, action):
        self.calls.append(action)
        if action["action"] == "boom":
            raise RuntimeError("simulated failure")
        return _FakeResult(platform=action["platform"], action=action["action"])


def _fresh_client(monkeypatch):
    """Reimport api_server with ExecutionGateway mocked, and return a
    FastAPI TestClient for it."""
    from fastapi.testclient import TestClient

    monkeypatch.setattr(eg_module, "ExecutionGateway", _FakeGateway)
    sys.modules.pop("api_server", None)
    import api_server
    return TestClient(api_server.app), api_server.gateway


def test_health_endpoint(monkeypatch):
    client, _ = _fresh_client(monkeypatch)
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_execute_endpoint_returns_result_fields(monkeypatch):
    client, gateway = _fresh_client(monkeypatch)
    response = client.post("/execute", json={
        "platform": "desktop", "action": "open_app", "value": "notepad",
    })
    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    assert body["platform"] == "desktop"
    assert body["action"] == "open_app"
    assert gateway.calls[0]["action"] == "open_app"


def test_execute_endpoint_passes_through_all_fields(monkeypatch):
    client, gateway = _fresh_client(monkeypatch)
    client.post("/execute", json={
        "platform": "browser", "action": "navigate", "value": "https://example.com",
        "target": {"selector": "#main"}, "parameters": {"timeout": 10},
        "approval_token": "abc",
    })
    call = gateway.calls[0]
    assert call["target"] == {"selector": "#main"}
    assert call["parameters"] == {"timeout": 10}
    assert call["approval_token"] == "abc"


def test_execute_endpoint_returns_500_on_unexpected_error(monkeypatch):
    client, _ = _fresh_client(monkeypatch)
    response = client.post("/execute", json={"platform": "desktop", "action": "boom"})
    assert response.status_code == 500
    assert "simulated failure" in response.json()["detail"]


def test_execute_endpoint_rejects_missing_required_fields(monkeypatch):
    client, _ = _fresh_client(monkeypatch)
    response = client.post("/execute", json={"platform": "desktop"})  # missing "action"
    assert response.status_code == 422
