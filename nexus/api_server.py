"""
HTTP bridge for Nexus -- exposes ExecutionGateway over HTTP so the MCIS
Node.js backend can call browser/desktop/office actions.
"""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Optional

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from execution_gateway import ExecutionGateway

app = FastAPI(title="Nexus Execution API")

# A single worker thread is required because Playwright's sync API is
# thread-affine (browser/context/page must stay on one thread). But if a
# single call ever hangs forever (e.g. searching for a desktop app that
# doesn't exist), that ONE stuck call would permanently block every future
# request behind it. To prevent that: if a call doesn't finish within
# GATEWAY_CALL_TIMEOUT, we give up waiting on it and spin up a brand new
# worker + gateway for all FUTURE requests -- the stuck call is abandoned
# rather than allowed to freeze the whole server.
GATEWAY_CALL_TIMEOUT = 25  # seconds -- a bit under the client's 30s timeout

_executor = None
gateway = None

# Because the worker is single-threaded (see comment above), a second goal
# arriving while the first is still executing just silently blocks inside
# run_in_executor with zero visibility for the caller — the Node side (and
# the voice UI) has no way to tell "still queued behind another goal" apart
# from "slow/stuck". These two counters make that state observable.
_queue_depth = 0  # requests submitted but not yet started executing
_currently_processing: Optional[str] = None  # action name of the in-flight call


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
async def execute_action(req: ActionRequest):
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
        _new_worker()  # abandon the stuck call, start fresh for next requests
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
        # How many other requests were already waiting when this one was
        # submitted — lets the caller distinguish "queued behind other
        # work" from "this one specific action is just slow".
        "queued_ahead": queued_ahead,
    }


@app.get("/queue-status")
def queue_status():
    return {
        "queue_depth": _queue_depth,
        "processing": _currently_processing,
        "busy": _queue_depth > 0 or _currently_processing is not None,
    }


@app.get("/health")
def health():
    return {"status": "ok"}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)