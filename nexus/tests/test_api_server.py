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


TEST_TOKEN = "test-device-token-0123456789"
AUTH = {"X-Device-Token": TEST_TOKEN}


def _fresh_client(monkeypatch, token=TEST_TOKEN, env=None):
    """Reimport api_server with ExecutionGateway mocked (and the given
    environment), and return a FastAPI TestClient for it. Requests made
    through the returned client carry the device token by default."""
    from fastapi.testclient import TestClient

    for key in ("NEXUS_DEVICE_TOKEN", "NEXUS_ALLOW_UNAUTHENTICATED_LOCAL", "NEXUS_BIND_HOST"):
        monkeypatch.delenv(key, raising=False)
    if token is not None:
        monkeypatch.setenv("NEXUS_DEVICE_TOKEN", token)
    for key, value in (env or {}).items():
        monkeypatch.setenv(key, value)
    monkeypatch.setattr(eg_module, "ExecutionGateway", _FakeGateway)
    # load_dotenv() must not pull a developer's real nexus/.env into the tests.
    monkeypatch.setattr("dotenv.load_dotenv", lambda *a, **k: False)
    sys.modules.pop("api_server", None)
    import api_server
    client = TestClient(api_server.app, headers=AUTH if token else {})
    return client, api_server.gateway


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


# --- device-token hardening (fail closed, constant-time, loopback by default) ---

def test_missing_token_is_rejected(monkeypatch):
    client, gateway = _fresh_client(monkeypatch)
    response = client.post("/execute", json={"platform": "desktop", "action": "open_app"}, headers={"X-Device-Token": ""})
    assert response.status_code == 401
    assert gateway.calls == []


def test_wrong_token_is_rejected_and_never_echoed(monkeypatch):
    client, gateway = _fresh_client(monkeypatch)
    response = client.post("/execute", json={"platform": "desktop", "action": "open_app"}, headers={"X-Device-Token": "wrong"})
    assert response.status_code == 401
    assert TEST_TOKEN not in response.text and "wrong" not in response.text
    assert gateway.calls == []
    assert client.get("/queue-status", headers={"X-Device-Token": "wrong"}).status_code == 401


def test_no_configured_token_fails_closed(monkeypatch):
    client, gateway = _fresh_client(monkeypatch, token=None)
    response = client.post("/execute", json={"platform": "desktop", "action": "open_app"})
    assert response.status_code == 503
    assert gateway.calls == []
    assert client.get("/queue-status").status_code == 503
    assert client.get("/health").status_code == 200  # liveness stays public


def test_local_dev_switch_only_works_on_loopback(monkeypatch):
    client, gateway = _fresh_client(monkeypatch, token=None, env={"NEXUS_ALLOW_UNAUTHENTICATED_LOCAL": "true"})
    assert client.post("/execute", json={"platform": "desktop", "action": "open_app"}).status_code == 200
    client2, gateway2 = _fresh_client(monkeypatch, token=None, env={"NEXUS_ALLOW_UNAUTHENTICATED_LOCAL": "true", "NEXUS_BIND_HOST": "0.0.0.0"})
    assert client2.post("/execute", json={"platform": "desktop", "action": "open_app"}).status_code == 503
    assert gateway2.calls == []


def test_defaults_to_loopback_and_refuses_network_bind_without_token(monkeypatch):
    import pytest
    _fresh_client(monkeypatch)
    import api_server
    assert api_server.NEXUS_BIND_HOST == "127.0.0.1"
    with pytest.raises(SystemExit):
        api_server.assert_safe_bind("0.0.0.0", None)
    api_server.assert_safe_bind("0.0.0.0", TEST_TOKEN)  # allowed with a token
    api_server.assert_safe_bind("127.0.0.1", None)       # allowed on loopback
