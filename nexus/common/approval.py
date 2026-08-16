"""Small integration boundary for the partner security platform.

This package does not create or persist approvals.  It only refuses a
high-risk action until the external security platform supplies a valid token.
"""

from collections.abc import Callable

from common.contracts import ExecutionAction, RiskLevel


HIGH_RISK_ACTIONS = {
    "delete_file", "delete_folder", "move_file", "move_folder",
    "rename_file", "rename_folder", "write_file", "write_document",
    "run_terminal", "kill_process", "close_app", "close_window",
    "send", "submit", "book", "pay", "purchase", "login",
}


class ApprovalRequiredError(PermissionError):
    pass


class ApprovalGate:
    def __init__(self, validator: Callable[[str, ExecutionAction], bool] | None = None):
        self.validator = validator or (lambda token, action: bool(token))

    def ensure_allowed(self, action: ExecutionAction) -> None:
        needs_approval = action.risk == RiskLevel.HIGH or action.action in HIGH_RISK_ACTIONS
        if not needs_approval:
            return
        if not action.approval_token or not self.validator(action.approval_token, action):
            raise ApprovalRequiredError(f"Approval is required before '{action.action}'.")
