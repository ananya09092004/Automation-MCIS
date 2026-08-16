"""Safe entry point for every desktop action from the orchestrator."""

from typing import Any

from common import ApprovalGate, ExecutionAction, ExecutionResult
from desktop.accessibility import DesktopAccessibilityDriver
from desktop.capabilities import FileExplorerCapability, OfficeCapability
from desktop.document_io import read_document, write_document
from desktop.executor.router import ActionRouter
from desktop.file_search import find_document
from perception.state_detector import ScreenStateDetector


# ActionRouter (desktop/executor/router.py) expects a specific dict key per
# action -- e.g. open_app needs "app", start_process needs "command". A
# caller (voice controller, future Brain/orchestrator, tests, ...) only
# has to supply ExecutionAction.value; this maps that single value onto
# whichever key the router actually needs for that action, so every
# caller doesn't have to know the router's internal key names. Actions
# that genuinely need more than one value (copy_file's source+destination,
# notify's title+message, etc.) still go through target/parameters as
# before -- there's no single value to map for those.
_SINGLE_VALUE_KEY_BY_ACTION = {
    "open_app": "app", "close_app": "app", "restart_app": "app", "focus_app": "app",
    "minimize_app": "app", "maximize_app": "app", "switch_to_app": "app",
    "create_file": "path", "delete_file": "path", "read_file": "path", "verify_path": "path",
    "create_folder": "path", "delete_folder": "path", "list_folder": "path",
    "capture_screen": "path", "capture_active_window": "path",
    "press_key": "key",
    "focus_window": "title", "maximize_window": "title", "minimize_window": "title",
    "close_window": "title", "window_exists": "title",
    "start_process": "command", "run_terminal": "command",
}


class DesktopPlatformExecutor:
    def __init__(self, approval_gate: ApprovalGate | None = None, router: ActionRouter | None = None,
                 accessibility: DesktopAccessibilityDriver | None = None):
        self.approval_gate = approval_gate or ApprovalGate()
        self.router = router or ActionRouter()
        self.accessibility = accessibility or DesktopAccessibilityDriver()
        self.file_explorer = FileExplorerCapability()
        self.office = OfficeCapability()
        self.screen_state = ScreenStateDetector()

    def execute(self, action: ExecutionAction | dict[str, Any]) -> ExecutionResult:
        action = ExecutionAction.from_dict(action) if isinstance(action, dict) else action
        if action.platform != "desktop":
            return ExecutionResult(False, "desktop", action.action, "Action targets a different platform.")
        try:
            self.approval_gate.ensure_allowed(action)
            if action.action in {"open_path", "reveal_file", "open_file", "list_items", "search_items", "create_word_document", "create_excel_workbook", "create_powerpoint_presentation", "read_word_document", "read_excel_rows", "inspect_powerpoint_presentation", "open_office_document", "read_document", "write_document", "find_document"}:
                return self._execute_capability_action(action)
            if action.action in {"click_target", "fill_target", "read_target", "target_exists", "wait_for_target", "inspect_window", "inspect_screen_state"}:
                return self._execute_target_action(action)
            payload = {"action": action.action, **action.parameters, **action.target}
            if action.value is not None:
                payload.setdefault("value", action.value)
                payload.setdefault("text", action.value)
                single_key = _SINGLE_VALUE_KEY_BY_ACTION.get(action.action)
                if single_key:
                    payload.setdefault(single_key, action.value)
            data = self.router.execute(payload)
            success = getattr(data, "success", data is not False)
            return ExecutionResult(success, "desktop", action.action,
                                   "Completed" if success else "Action failed", data=data,
                                   evidence={"verified": bool(success)})
        except Exception as error:
            return ExecutionResult(False, "desktop", action.action, "Desktop action failed", error=str(error))

    def _execute_capability_action(self, action: ExecutionAction) -> ExecutionResult:
        parameters = action.parameters
        if action.action == "open_path": data = self.file_explorer.open_path(parameters["path"])
        elif action.action == "reveal_file": data = self.file_explorer.reveal_file(parameters["path"])
        elif action.action == "open_file": data = self.file_explorer.open_file(parameters["path"])
        elif action.action == "list_items": data = self.file_explorer.list_items(parameters["path"])
        elif action.action == "search_items": data = self.file_explorer.search(parameters["directory"], parameters["query"])
        elif action.action == "create_word_document": data = self.office.create_word_document(parameters["path"], str(action.value or ""))
        elif action.action == "create_excel_workbook": data = self.office.create_excel_workbook(parameters["path"], action.value or [])
        elif action.action == "create_powerpoint_presentation": data = self.office.create_powerpoint_presentation(parameters["path"], parameters.get("title", ""), str(action.value or ""))
        elif action.action == "read_word_document": data = self.office.read_word_document(parameters["path"])
        elif action.action == "read_excel_rows": data = self.office.read_excel_rows(parameters["path"])
        elif action.action == "inspect_powerpoint_presentation": data = self.office.inspect_powerpoint_presentation(parameters["path"])
        elif action.action == "read_document": data = read_document(parameters["path"])
        elif action.action == "write_document":
            write_document(parameters["path"], str(action.value or ""))
            data = True
        elif action.action == "find_document": data = find_document(parameters["query"], parameters.get("root"))
        else: data = self.office.open_document(parameters["path"])
        return ExecutionResult(bool(data) or isinstance(data, list), "desktop", action.action, "Completed", data=data, evidence={"verified": bool(data) or isinstance(data, list)})

    def _execute_target_action(self, action: ExecutionAction) -> ExecutionResult:
        if action.action == "inspect_screen_state":
            data = self.screen_state.detect().as_dict()
            return ExecutionResult(True, "desktop", action.action, "Completed", data=data,
                                   evidence={"verified": True, "state": data["state"], "safe_to_act": data["safe_to_act"]})
        if action.action == "click_target":
            evidence = self.accessibility.click(action.target)
            data = True
        elif action.action == "fill_target":
            evidence = self.accessibility.fill(action.target, str(action.value))
            data = True
        elif action.action == "read_target":
            data, evidence = self.accessibility.read(action.target)
        elif action.action == "wait_for_target":
            evidence = self.accessibility.wait_for(action.target, action.parameters.get("timeout", 10))
            data = True
        elif action.action == "inspect_window":
            data = self.accessibility.inspect_window(action.target["window_title"], action.parameters.get("max_controls", 250))
            evidence = {"method": "uia", "control_count": len(data)}
        else:
            data = self.accessibility.exists(action.target)
            evidence = {"method": "uia", "verified": data}
        proof = evidence.__dict__ if hasattr(evidence, "__dict__") else evidence
        proof["verified"] = bool(data) if action.action == "target_exists" else True
        return ExecutionResult(bool(data) if action.action == "target_exists" else True, "desktop", action.action,
                               "Completed", data=data, evidence=proof)
