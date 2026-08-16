"""Generate only known-safe compensating actions; irreversible work is never rolled back automatically."""

from common import ExecutionAction


class SafeRollback:
    def compensation_for(self, action: ExecutionAction) -> ExecutionAction | None:
        parameters = action.parameters
        if action.platform == "desktop" and action.action == "create_file":
            return ExecutionAction("desktop", "delete_file", parameters={"path": parameters.get("path")}, approval_token=action.approval_token)
        if action.platform == "desktop" and action.action == "create_folder":
            return ExecutionAction("desktop", "delete_folder", parameters={"path": parameters.get("path")}, approval_token=action.approval_token)
        if action.platform == "browser" and action.action == "new_tab":
            return ExecutionAction("browser", "close_tab")
        return None
