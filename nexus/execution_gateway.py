"""Single entry point for platform actions sent by the partner orchestrator."""

from typing import Any

from common import ApprovalGate, ExecutionAction, ExecutionResult, default_capabilities
from common.approval import ApprovalRequiredError
from execution_state import StateTracker
from execution_evidence import EvidenceCollector


class ExecutionGateway:
    def __init__(self, approval_gate: ApprovalGate | None = None, desktop_executor=None,
                 browser_executor=None, evidence_collector=None):
        self.approval_gate = approval_gate or ApprovalGate()
        self.capabilities = default_capabilities()
        if desktop_executor is None:
            from desktop.platform_executor import DesktopPlatformExecutor
            desktop_executor = DesktopPlatformExecutor(self.approval_gate)
        if browser_executor is None:
            from browser.platform_executor import BrowserPlatformExecutor
            browser_executor = BrowserPlatformExecutor(self.approval_gate)
        self.desktop = desktop_executor
        self.browser = browser_executor
        self.state = StateTracker()
        self.evidence_collector = evidence_collector or EvidenceCollector()

    def execute(self, action: ExecutionAction | dict[str, Any]) -> ExecutionResult:
        action = ExecutionAction.from_dict(action) if isinstance(action, dict) else action
        if not self.capabilities.supports(action.platform, action.action):
            return ExecutionResult(False, action.platform, action.action, "Unsupported action for this platform.")
        try:
            # Enforce at the shared entry point as well as platform adapters so
            # a future adapter cannot accidentally bypass confirmation rules.
            self.approval_gate.ensure_allowed(action)
        except ApprovalRequiredError as error:
            return ExecutionResult(False, action.platform, action.action, "Action blocked pending user approval.", error=str(error))
        self.state.record(action.platform, action.action, phase="before")
        evidence = self._capture_evidence(action, "before")
        if action.platform == "desktop": result = self.desktop.execute(action)
        elif action.platform == "browser": result = self.browser.execute(action)
        else: result = ExecutionResult(False, action.platform, action.action, "Unsupported platform.")
        evidence.update(self._capture_evidence(action, "after"))
        if evidence:
            result.evidence["artifacts"] = evidence
        result.evidence["state"] = self.state.record(action.platform, action.action, phase="after", success=result.success).__dict__
        return result

    def _capture_evidence(self, action: ExecutionAction, phase: str) -> dict:
        """Optional screenshots; inability to capture evidence must never alter an action result."""
        if not action.parameters.get("capture_evidence"):
            return {}
        try:
            if action.platform == "desktop":
                return {phase: self.evidence_collector.desktop_screenshot(f"{phase}_{action.action}")}
            page = getattr(getattr(self.browser, "controller", None), "page", None)
            if page is not None:
                return {phase: self.evidence_collector.browser_screenshot(page, f"{phase}_{action.action}")}
        except Exception as error:
            return {f"{phase}_capture_error": str(error)}
        return {}

    def close(self) -> None:
        self.browser.stop()

    def workflow(self):
        from execution_workflow import ExecutionWorkflow
        return ExecutionWorkflow(self)
