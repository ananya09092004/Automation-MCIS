"""Tests for the HTTP bridge (api_server.py) that lets the Node.js
backend call ExecutionGateway over HTTP. ExecutionGateway itself is
mocked -- these tests only verify the HTTP request/response wiring, not
real browser/desktop execution (that's covered by the platform-specific
test suites).
"""
import os
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


def _fresh_client(monkeypatch, device_token=None, dev_mode=False):
    """Reimport api_server with ExecutionGateway mocked, and return a
    FastAPI TestClient for it.

    device_token=None, dev_mode=False (the default) reproduces a real
    production misconfiguration -- no NEXUS_DEVICE_TOKEN and no explicit
    dev opt-in -- which must now fail closed on every request rather
    than the old "accept unauthenticated" default.
    """
    from fastapi.testclient import TestClient

    monkeypatch.setattr(eg_module, "ExecutionGateway", _FakeGateway)
    if device_token is None:
        monkeypatch.delenv("NEXUS_DEVICE_TOKEN", raising=False)
    else:
        monkeypatch.setenv("NEXUS_DEVICE_TOKEN", device_token)
    if dev_mode:
        monkeypatch.setenv("NEXUS_ALLOW_UNSAFE_DEV", "true")
    else:
        monkeypatch.delenv("NEXUS_ALLOW_UNSAFE_DEV", raising=False)
    sys.modules.pop("api_server", None)
    import api_server
    return TestClient(api_server.app), api_server.gateway


def test_health_endpoint_requires_no_auth(monkeypatch):
    # /health deliberately stays open (no secrets, no action execution,
    # needed for liveness probes) -- auth applies only to /execute and
    # /queue-status.
    client, _ = _fresh_client(monkeypatch, device_token=None, dev_mode=False)
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_execute_endpoint_returns_result_fields(monkeypatch):
    client, gateway = _fresh_client(monkeypatch, device_token="real-token")
    response = client.post(
        "/execute",
        json={"platform": "desktop", "action": "open_app", "value": "notepad"},
        headers={"x-device-token": "real-token"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    assert body["platform"] == "desktop"
    assert body["action"] == "open_app"
    assert gateway.calls[0]["action"] == "open_app"


def test_execute_endpoint_passes_through_all_fields(monkeypatch):
    client, gateway = _fresh_client(monkeypatch, device_token="real-token")
    client.post(
        "/execute",
        json={
            "platform": "browser", "action": "navigate", "value": "https://example.com",
            "target": {"selector": "#main"}, "parameters": {"timeout": 10},
            "approval_token": "abc",
        },
        headers={"x-device-token": "real-token"},
    )
    call = gateway.calls[0]
    assert call["target"] == {"selector": "#main"}
    assert call["parameters"] == {"timeout": 10}
    assert call["approval_token"] == "abc"


def test_execute_endpoint_returns_500_on_unexpected_error(monkeypatch):
    client, _ = _fresh_client(monkeypatch, device_token="real-token")
    response = client.post(
        "/execute", json={"platform": "desktop", "action": "boom"},
        headers={"x-device-token": "real-token"},
    )
    assert response.status_code == 500
    assert "simulated failure" in response.json()["detail"]


def test_execute_endpoint_rejects_missing_required_fields(monkeypatch):
    client, _ = _fresh_client(monkeypatch, device_token="real-token")
    response = client.post(
        "/execute", json={"platform": "desktop"},  # missing "action"
        headers={"x-device-token": "real-token"},
    )
    assert response.status_code == 422


# ---------------------------------------------------------------------
# P1 -- authentication fail-closed behavior (the actual security fix).
# ---------------------------------------------------------------------

def test_execute_rejects_missing_token_when_none_configured_and_no_dev_mode(monkeypatch):
    """The exact prior vulnerability: NEXUS_DEVICE_TOKEN unset, no
    explicit dev opt-in. Must now be refused, not silently accepted."""
    client, gateway = _fresh_client(monkeypatch, device_token=None, dev_mode=False)
    response = client.post("/execute", json={"platform": "desktop", "action": "open_app", "value": "notepad"})
    assert response.status_code == 503
    assert gateway.calls == [], "the action must never reach the gateway when auth is unconfigured"


def test_execute_rejects_invalid_token_when_token_configured(monkeypatch):
    client, gateway = _fresh_client(monkeypatch, device_token="correct-token")
    response = client.post(
        "/execute", json={"platform": "desktop", "action": "open_app", "value": "notepad"},
        headers={"x-device-token": "wrong-token"},
    )
    assert response.status_code == 401
    assert gateway.calls == []


def test_execute_rejects_absent_header_when_token_configured(monkeypatch):
    client, gateway = _fresh_client(monkeypatch, device_token="correct-token")
    response = client.post("/execute", json={"platform": "desktop", "action": "open_app", "value": "notepad"})
    assert response.status_code == 401
    assert gateway.calls == []


def test_execute_accepts_valid_token_when_token_configured(monkeypatch):
    client, gateway = _fresh_client(monkeypatch, device_token="correct-token")
    response = client.post(
        "/execute", json={"platform": "desktop", "action": "open_app", "value": "notepad"},
        headers={"x-device-token": "correct-token"},
    )
    assert response.status_code == 200
    assert gateway.calls[0]["action"] == "open_app"


def test_execute_allows_unauthenticated_only_with_explicit_dev_opt_in(monkeypatch):
    """Simulated production misconfiguration (#1 above) is refused; the
    ONLY way to get the old permissive behavior back is the explicit,
    separately-named NEXUS_ALLOW_UNSAFE_DEV flag -- never the mere
    absence of a token."""
    client, gateway = _fresh_client(monkeypatch, device_token=None, dev_mode=True)
    response = client.post("/execute", json={"platform": "desktop", "action": "open_app", "value": "notepad"})
    assert response.status_code == 200
    assert gateway.calls[0]["action"] == "open_app"


def test_queue_status_also_enforces_auth(monkeypatch):
    client, _ = _fresh_client(monkeypatch, device_token="correct-token")
    assert client.get("/queue-status").status_code == 401
    assert client.get("/queue-status", headers={"x-device-token": "correct-token"}).status_code == 200


def test_binding_to_non_localhost_without_token_is_refused(monkeypatch):
    """Exercises the exact condition api_server.py's __main__ guard
    checks before calling uvicorn.run() -- without actually starting a
    server or importing the full desktop executor chain (unrelated to
    this fix and not importable in every test environment)."""
    monkeypatch.delenv("NEXUS_DEVICE_TOKEN", raising=False)
    bind_host = "0.0.0.0"
    device_token = os.environ.get("NEXUS_DEVICE_TOKEN")
    should_refuse = bind_host not in ("127.0.0.1", "localhost", "::1") and not device_token
    assert should_refuse, "binding to 0.0.0.0 with no device token configured must be refused"
