"""Small integration boundary for the partner security platform.

This package does not create or persist approvals. It only refuses a
high-risk action until it is given a token that cryptographically proves
a human approved EXACTLY this action -- not just "some token was present".

-- P-SEC-1 (security hardening, pre-launch) --------------------------------
Earlier, ``ApprovalGate``'s default validator was ``lambda token, action:
bool(token)`` -- ANY non-empty string satisfied approval for every
HIGH_RISK_ACTIONS item (run_terminal, delete_file, close_app, pay, login,
...), for every executor (desktop, browser, and any future one). Nothing
bound the token to the action it was supposedly approving, so a token
approved for one action could be replayed for a different one, and the
only thing stopping an LLM-planned/prompt-injected action from supplying
its own approval_token was a single manual ``.pop("approval_token")`` in
controller.py's planning step -- a convention, not a security boundary.

This module now mints and verifies short-lived, single-use, HMAC-SHA256
tokens that are cryptographically bound to the exact action (platform,
action name, target, value, parameters, risk) plus the caller/workspace
context available at issuance time. A token minted for one action fails
verification against any other action, workspace, or caller. See
``issue_approval_token`` / ``verify_approval_token`` below, and
``ApprovalGate``'s default validator, which now calls ``verify_approval_token``
instead of checking mere presence.

Nothing here duplicates or weakens the Node backend's Agent Firewall
ticket system (mcis/backend/services/security/agentFirewall.js), which
remains the authority for connector/workflow actions reached through that
backend. This module is the equivalent control for the local desktop /
browser / terminal executors in this Python process, reusable by any
future high-risk executor the same way.
"""

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from collections.abc import Callable

from common.contracts import ExecutionAction, RiskLevel

HIGH_RISK_ACTIONS = {
    "delete_file", "delete_folder", "move_file", "move_folder",
    "rename_file", "rename_folder", "write_file", "write_document",
    "run_terminal", "kill_process", "close_app", "close_window",
    "send", "submit", "book", "pay", "purchase", "login",
    # P-SEC-6 (security hardening, pre-launch, D1): start_process and
    # restart_process (desktop/process_manager/controller.py) run an
    # arbitrary caller-supplied shell command via subprocess.Popen(...,
    # shell=True) -- exactly the same shell=True exposure as
    # run_terminal, just fire-and-forget (launch and detach) instead of
    # wait-for-output, which is why it has no timeout clamp the way
    # run_terminal does (there's nothing to wait on). Despite running
    # the same kind of arbitrary shell command, these two names were
    # missing from this set entirely, so they ran with NO approval
    # token required and NO risk classification on either this gate or
    # backend-routing/riskModel.js's RED tier -- effectively
    # unauthorized command execution reachable through the exact same
    # plan/voice path run_terminal uses. Added here so the existing,
    # already-tested HMAC approval-binding (issue_approval_token /
    # verify_approval_token) now covers them the same way.
    "start_process", "restart_process",
}

_TOKEN_VERSION = "v1"
# Long enough to cover a human confirm() round trip (voice/UI dialogue),
# short enough to meaningfully bound a leaked/overheard token's lifetime.
DEFAULT_TTL_SECONDS = 300

# Tokens are single-use: once verified, their nonce is recorded so a
# second verification attempt (replay) is rejected. This is intentionally
# process-lifetime, in-memory state -- this module has no database of its
# own, mirrors how ApprovalGate itself has always been a pure in-process
# gate, and a replayed token is still rejected the moment this process
# (desktop agent / voice session) that minted it ever sees it twice.
_used_nonces: set[str] = set()

_process_secret: bytes | None = None


class ApprovalRequiredError(PermissionError):
    pass


class ApprovalTokenError(ValueError):
    """A token was malformed, unparseable, or otherwise structurally invalid.
    Raised internally; callers of verify_approval_token get False, not this
    exception -- it exists so internal parsing has one place to fail."""


def _secret() -> bytes:
    """HMAC key for minting/verifying approval tokens.

    Prefers NEXUS_APPROVAL_SECRET (set this in any deployment where
    tokens minted by one process must be verifiable by another, or where
    the operator wants a stable, auditable secret). Falls back to a
    random per-process secret so a bare desktop-agent run still gets real
    cryptographic binding out of the box -- a token minted with the
    fallback secret can only ever be verified by the same running
    process, which is exactly the process that will verify it (voice
    confirm -> same-process execute), so this is not a weaker guarantee
    for the single-user desktop deployment this module primarily serves.
    """
    configured = os.environ.get("NEXUS_APPROVAL_SECRET")
    if configured:
        return configured.encode("utf-8")
    global _process_secret
    if _process_secret is None:
        _process_secret = secrets.token_bytes(32)
    return _process_secret


def _canonical_action_fields(action: ExecutionAction) -> dict:
    """The exact set of fields a token is bound to. Anything not listed
    here (e.g. approval_token itself) must never affect binding."""
    risk = action.risk
    risk_value = risk.value if isinstance(risk, RiskLevel) else str(risk)
    return {
        "platform": action.platform,
        "action": action.action,
        "target": action.target or {},
        "value": action.value,
        "parameters": action.parameters or {},
        "risk": risk_value,
    }


def _canonical_json(data: dict) -> str:
    return json.dumps(data, sort_keys=True, separators=(",", ":"), default=str)


def _as_execution_action(action: ExecutionAction | dict) -> ExecutionAction:
    if isinstance(action, ExecutionAction):
        return action
    payload = dict(action)
    payload.pop("approval_token", None)
    return ExecutionAction.from_dict(payload)


def _b64_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _b64_decode(data: str) -> bytes:
    padded = data + "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii"))


def issue_approval_token(
    action: ExecutionAction | dict,
    *,
    workspace_id: str | None = None,
    caller_id: str | None = None,
    ttl_seconds: int = DEFAULT_TTL_SECONDS,
) -> str:
    """Mint a token that approves EXACTLY this action (and only this
    action) for the given workspace/caller, expiring after ttl_seconds.

    Call this ONLY at the moment a human actually approves the action
    (a confirm() callback returning True, an explicit UI "Approve" click,
    etc.) -- never from planning/LLM-output code, and never speculatively
    ahead of time for an action that might change before it executes.
    """
    resolved = _as_execution_action(action)
    now = int(time.time())
    payload = {
        "v": _TOKEN_VERSION,
        "nonce": secrets.token_hex(16),
        "iat": now,
        "exp": now + max(1, int(ttl_seconds)),
        "ws": workspace_id,
        "caller": caller_id,
        "fields": _canonical_action_fields(resolved),
    }
    body_b64 = _b64_encode(_canonical_json(payload).encode("utf-8"))
    signature = hmac.new(_secret(), body_b64.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{_TOKEN_VERSION}.{body_b64}.{signature}"


def verify_approval_token(
    token: str | None,
    action: ExecutionAction | dict,
    *,
    workspace_id: str | None = None,
    caller_id: str | None = None,
    consume: bool = True,
) -> bool:
    """True only if `token` was minted by issue_approval_token for THIS
    EXACT action (same platform/action/target/value/parameters/risk) and
    THIS EXACT workspace/caller, has not expired, has not already been
    consumed (replay), and its signature verifies against our secret.

    Any failure mode (malformed token, tampered signature, wrong action,
    wrong input, wrong workspace, expired, already-used, empty/None token,
    an arbitrary non-empty string that isn't a real token at all) returns
    False -- fail closed, uniformly, with no distinguishing error leaked
    to the caller.
    """
    if not token or not isinstance(token, str):
        return False
    try:
        version, body_b64, signature = token.split(".", 2)
    except ValueError:
        return False
    if version != _TOKEN_VERSION or not body_b64 or not signature:
        return False

    expected_signature = hmac.new(_secret(), body_b64.encode("ascii"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected_signature, signature):
        return False  # tampered or wrong-secret token

    try:
        payload = json.loads(_b64_decode(body_b64).decode("utf-8"))
    except Exception:
        return False
    if not isinstance(payload, dict):
        return False

    exp = payload.get("exp")
    if not isinstance(exp, int) or int(time.time()) > exp:
        return False  # expired

    nonce = payload.get("nonce")
    if not nonce or not isinstance(nonce, str):
        return False

    resolved = _as_execution_action(action)
    if payload.get("fields") != _canonical_action_fields(resolved):
        return False  # action or input substitution
    if payload.get("ws") != workspace_id:
        return False  # wrong workspace
    if payload.get("caller") != caller_id:
        return False  # wrong caller

    if consume:
        if nonce in _used_nonces:
            return False  # replay
        _used_nonces.add(nonce)
    return True


class ApprovalGate:
    def __init__(
        self,
        validator: Callable[[str, ExecutionAction], bool] | None = None,
        *,
        workspace_id: str | None = None,
        caller_id: str | None = None,
    ):
        self._workspace_id = workspace_id
        self._caller_id = caller_id
        self.validator = validator or self._default_validator

    def _default_validator(self, token: str, action: ExecutionAction) -> bool:
        return verify_approval_token(
            token, action, workspace_id=self._workspace_id, caller_id=self._caller_id
        )

    def ensure_allowed(self, action: ExecutionAction) -> None:
        needs_approval = action.risk == RiskLevel.HIGH or action.action in HIGH_RISK_ACTIONS
        if not needs_approval:
            return
        if not action.approval_token or not self.validator(action.approval_token, action):
            raise ApprovalRequiredError(f"Approval is required before '{action.action}'.")
