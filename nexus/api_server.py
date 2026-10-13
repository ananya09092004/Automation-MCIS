"""
HTTP bridge for Nexus -- exposes ExecutionGateway over HTTP so the MCIS
Node.js backend can call browser/desktop/office actions.
"""
import asyncio
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

NEXUS_DEVICE_TOKEN = os.environ.get("NEXUS_DEVICE_TOKEN")

# Previously: an unset NEXUS_DEVICE_TOKEN silently accepted every
# request (one warning line, then open access) -- this server binds
# 0.0.0.0 by default, so a missing env var turned "execute arbitrary
# desktop/browser action" into an unauthenticated endpoint reachable by
# anything that can reach the port. Now this is fail-CLOSED: no token
# configured means no requests are served, unless the operator
# explicitly opts into local-only development mode.
NEXUS_DEV_MODE = os.environ.get("NEXUS_ALLOW_UNSAFE_DEV") == "true"

if not NEXUS_DEVICE_TOKEN and not NEXUS_DEV_MODE:
    print(
        "[Nexus] FATAL: NEXUS_DEVICE_TOKEN is not set. Every /execute and "
        "/queue-status request will be rejected (fail-closed) until it is "
        "set. For local development ONLY, set NEXUS_ALLOW_UNSAFE_DEV=true "
        "to run without a token -- never do this on a machine reachable "
        "from outside localhost."
    )
elif not NEXUS_DEVICE_TOKEN and NEXUS_DEV_MODE:
    print(
        "[Nexus] WARNING: running with NEXUS_ALLOW_UNSAFE_DEV=true and no "
        "device token -- every request is accepted unauthenticated. This "
        "is only safe when nothing but localhost can reach this process."
    )


def verify_token(x_device_token: Optional[str] = Header(default=None)):
    if NEXUS_DEVICE_TOKEN:
        if x_device_token != NEXUS_DEVICE_TOKEN:
            raise HTTPException(status_code=401, detail="Invalid or missing device token.")
        return True
    if NEXUS_DEV_MODE:
        # Explicit, operator-opted-in, logged at startup above.
        return True
    # Fail closed: no token configured and dev mode not explicitly
    # requested -- never fall through to "accept anyway".
    raise HTTPException(
        status_code=503,
        detail="Nexus execution API is not configured for authentication "
               "(NEXUS_DEVICE_TOKEN is unset). Refusing all requests.",
    )


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
    # Default to localhost-only -- the previous unconditional 0.0.0.0
    # bind meant any machine that could route to this host's IP could
    # reach the execution API, combined with the auth gap above this
    # was "anyone on the network can run desktop/browser actions" by
    # default. Remote access now requires an explicit opt-in via
    # NEXUS_BIND_HOST, and binding to anything other than loopback
    # without a real device token configured is refused outright --
    # the fail-closed auth check above is not a substitute for network
    # exposure control, both are required together.
    bind_host = os.environ.get("NEXUS_BIND_HOST", "127.0.0.1")
    if bind_host not in ("127.0.0.1", "localhost", "::1") and not NEXUS_DEVICE_TOKEN:
        raise SystemExit(
            f"[Nexus] Refusing to bind to '{bind_host}' (non-localhost) without "
            "NEXUS_DEVICE_TOKEN set. Set a device token before exposing this "
            "API beyond localhost."
        )
    uvicorn.run(app, host=bind_host, port=int(os.environ.get("NEXUS_PORT", "8000")))