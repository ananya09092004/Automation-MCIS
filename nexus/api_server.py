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
    loop = asyncio.get_event_loop()
    future = loop.run_in_executor(_executor, gateway.execute, req.model_dump())

    try:
        result = await asyncio.wait_for(future, timeout=GATEWAY_CALL_TIMEOUT)
    except asyncio.TimeoutError:
        _new_worker()  # abandon the stuck call, start fresh for next requests
        raise HTTPException(
            status_code=504,
            detail=f"Action '{req.action}' timed out after {GATEWAY_CALL_TIMEOUT}s and was abandoned. A fresh session has started for future requests.",
        )
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error))

    return {
        "success": result.success,
        "platform": result.platform,
        "action": result.action,
        "message": getattr(result, "message", None),
        "data": getattr(result, "data", None),
        "error": getattr(result, "error", None),
        "evidence": getattr(result, "evidence", None),
    }


@app.get("/health")
def health():
    return {"status": "ok"}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)