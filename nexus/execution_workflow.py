"""Multi-step execution with conservative retries and complete step results."""

from dataclasses import dataclass, field
from time import sleep
from typing import Iterable

from common import ExecutionAction, ExecutionResult
from safe_rollback import SafeRollback


SAFE_RETRY_ACTIONS = {
    "navigate", "back", "forward", "refresh", "wait_for", "inspect_page",
    "read_text", "target_exists", "read_target", "get_clipboard",
}


@dataclass
class WorkflowResult:
    success: bool
    results: list[ExecutionResult] = field(default_factory=list)
    failed_step: int | None = None
    recovery_report: dict | None = None
    rollback_results: list[ExecutionResult] = field(default_factory=list)


class ExecutionWorkflow:
    def __init__(self, gateway, retry_delay: float = 0.25):
        self.gateway = gateway
        self.retry_delay = retry_delay

    def run(self, actions: Iterable[ExecutionAction | dict], max_attempts: int = 2,
            rollback_on_failure: bool = False) -> WorkflowResult:
        results: list[ExecutionResult] = []
        compensations: list[ExecutionAction] = []
        rollback = SafeRollback()
        for index, action in enumerate(actions):
            action = ExecutionAction.from_dict(action) if isinstance(action, dict) else action
            attempts = max_attempts if action.action in SAFE_RETRY_ACTIONS else 1
            result = None
            for attempt in range(attempts):
                result = self.gateway.execute(action)
                result.evidence.setdefault("attempt", attempt + 1)
                if result.success:
                    break
                if attempt + 1 < attempts:
                    sleep(self.retry_delay)
            results.append(result)
            if result.success:
                compensation = rollback.compensation_for(action)
                if compensation is not None:
                    compensations.append(compensation)
            if not result.success:
                rollback_results = self._rollback(compensations) if rollback_on_failure else []
                return WorkflowResult(False, results, index, {
                    "status": "stopped_safely",
                    "failed_step": index,
                    "action": action.action,
                    "platform": action.platform,
                    "attempts": result.evidence.get("attempt", 1),
                    "error": result.error or result.message,
                    "next_step": "Request user guidance or re-plan; do not continue with later actions.",
                }, rollback_results)
        return WorkflowResult(True, results)

    def _rollback(self, compensations: list[ExecutionAction]) -> list[ExecutionResult]:
        """Execute only known compensations and record every outcome; never invent rollback actions."""
        return [self.gateway.execute(action) for action in reversed(compensations)]
