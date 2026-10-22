"""
HTTP bridge for Nexus -- exposes ExecutionGateway over HTTP so the MCIS
Node.js backend can call browser/desktop/office actions.
"""
import asyncio
import hmac
import os
from dotenv import load_dotenv
load_dotenv()
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Optional

import uvicorn
from fastapi import FastAPI, HTTPException, Header
from pydantic import BaseModel

from execution_gateway import ExecutionGateway

app = FastAPI(title="Nexus Execution API")

NEXUS_DEVICE_TOKEN = os.environ.get("NEXUS_DEVICE_TOKEN") or None

# Network exposure: loopback by default. Set NEXUS_BIND_HOST (e.g. 0.0.0.0) only
# behind a firewall/tunnel, and never without NEXUS_DEVICE_TOKEN (refused below).
NEXUS_BIND_HOST = os.environ.get("NEXUS_BIND_HOST", "127.0.0.1").strip() or "127.0.0.1"
NEXUS_PORT = int(os.environ.get("NEXUS_PORT", "8000"))
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}

# Explicit, loopback-only development switch. Without a token and without this
# switch the server FAILS CLOSED: every action endpoint answers 503.
ALLOW_UNAUTHENTICATED_LOCAL = (
    os.environ.get("NEXUS_ALLOW_UNAUTHENTICATED_LOCAL", "").strip().lower() in ("1", "true", "yes")
    and NEXUS_BIND_HOST in LOOPBACK_HOSTS
)

if not NEXUS_DEVICE_TOKEN:
    if ALLOW_UNAUTHENTICATED_LOCAL:
        print("[Nexus] WARNING: NEXUS_DEVICE_TOKEN is not set; NEXUS_ALLOW_UNAUTHENTICATED_LOCAL is on (loopback only). Development use only.")
    else:
        print("[Nexus] NEXUS_DEVICE_TOKEN is not set: action endpoints are DISABLED (503) until a token is configured.")


def verify_token(x_device_token: Optional[str] = Header(default=None)):
    """Fail closed. Constant-time comparison; the token value is never logged or echoed."""
    if not NEXUS_DEVICE_TOKEN:
        if ALLOW_UNAUTHENTICATED_LOCAL:
            return True
        raise HTTPException(status_code=503, detail="Nexus is not configured: set NEXUS_DEVICE_TOKEN on this machine and in the backend.")
    supplied = (x_device_token or "").encode("utf-8")
    if not hmac.compare_digest(supplied, NEXUS_DEVICE_TOKEN.encode("utf-8")):
        raise HTTPException(status_code=401, detail="Invalid or missing device token.")
    return True


def assert_safe_bind(host: str, token: Optional[str]) -> None:
    """Refuse to expose action endpoints beyond loopback without a device token."""
    if host not in LOOPBACK_HOSTS and not token:
        raise SystemExit(f"[Nexus] Refusing to listen on {host} without NEXUS_DEVICE_TOKEN. Set a token or bind to 127.0.0.1.")


GATEWAY_CALL_TIMEOUT = 25

_executor = None
gateway = None

_queue_depth = 0
_currently_processing: Optional[str] = None


def _new_worker():
    global _executor, gateway
    _executor = ThreadPoolExecutor(max_workers=1)
    gateway = ExecutionGateway()


_new_worker()


class ActionRequest(BaseModel):
    platform: str
    action: str
    parameters: dict[str, Any] = {}
    target: dict[str, Any] = {}
    value: Optional[Any] = None
    approval_token: Optional[str] = None


@app.post("/execute")
async def execute_action(req: ActionRequest, x_device_token: Optional[str] = Header(default=None)):
    verify_token(x_device_token)

    global _queue_depth, _currently_processing

    queued_ahead = _queue_depth
    _queue_depth += 1
    loop = asyncio.get_event_loop()

    def _run():
        global _currently_processing
        _currently_processing = req.action
        try:
            return gateway.execute(req.model_dump())
        finally:
            _currently_processing = None

    future = loop.run_in_executor(_executor, _run)

    try:
        result = await asyncio.wait_for(future, timeout=GATEWAY_CALL_TIMEOUT)
    except asyncio.TimeoutError:
        _new_worker()
        _queue_depth = max(0, _queue_depth - 1)
        raise HTTPException(
            status_code=504,
            detail=f"Action '{req.action}' timed out after {GATEWAY_CALL_TIMEOUT}s and was abandoned. A fresh session has started for future requests.",
        )
    except Exception as error:
        _queue_depth = max(0, _queue_depth - 1)
        raise HTTPException(status_code=500, detail=str(error))

    _queue_depth = max(0, _queue_depth - 1)

    return {
        "success": result.success,
        "platform": result.platform,
        "action": result.action,
        "message": getattr(result, "message", None),
        "data": getattr(result, "data", None),
        "error": getattr(result, "error", None),
        "evidence": getattr(result, "evidence", None),
        "queued_ahead": queued_ahead,
    }


@app.get("/queue-status")
def queue_status(x_device_token: Optional[str] = Header(default=None)):
    verify_token(x_device_token)
    return {
        "queue_depth": _queue_depth,
        "processing": _currently_processing,
        "busy": _queue_depth > 0 or _currently_processing is not None,
    }


@app.get("/health")
def health():
    return {"status": "ok"}


if __name__ == "__main__":
    assert_safe_bind(NEXUS_BIND_HOST, NEXUS_DEVICE_TOKEN)
    uvicorn.run(app, host=NEXUS_BIND_HOST, port=NEXUS_PORT)