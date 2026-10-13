"""Generic, planner-agnostic desktop workflow execution with conservative recovery."""

from dataclasses import dataclass, field
from typing import Iterable

from common import ExecutionAction, ExecutionResult


@dataclass
class DesktopWorkflowResult:
    success: bool
    results: list[ExecutionResult] = field(default_factory=list)
    recovery: dict | None = None


class DesktopAppWorkflow:
    """Run a supplied desktop action sequence; it never invents or retries risky actions."""

    READ_ONLY_ACTIONS = {"inspect_window", "read_target", "target_exists", "wait_for_target", "inspect_screen_state"}

    def __init__(self, executor):
        self.executor = executor

    def run(self, actions: Iterable[ExecutionAction | dict]) -> DesktopWorkflowResult:
        results = []
        for step, action in enumerate(actions):
            action = ExecutionAction.from_dict(action) if isinstance(action, dict) else action
            if action.platform != "desktop":
                result = ExecutionResult(False, "desktop", action.action, "Desktop workflow received a non-desktop action.")
            else:
                result = self.executor.execute(action)
            results.append(result)
            if not result.success:
                return DesktopWorkflowResult(False, results, self._safe_recovery(step, action, result))
        return DesktopWorkflowResult(True, results)

    def _safe_recovery(self, step: int, action: ExecutionAction, result: ExecutionResult) -> dict:
        """Report state only—do not click, close, save, or retry after failure."""
        state = None
        try:
            observation = self.executor.execute(ExecutionAction("desktop", "inspect_screen_state"))
            if observation.success:
                state = observation.data
        except Exception:
            pass
        return {
            "status": "stopped_safely", "failed_step": step, "action": action.action,
            "error": result.error or result.message, "screen_state": state,
            "next_step": "Request user guidance or send a new plan; no automatic risky recovery was performed.",
        }
