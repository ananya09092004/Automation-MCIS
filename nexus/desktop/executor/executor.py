from .router import ActionRouter
from .result import ActionResult


class DesktopExecutor:

    def __init__(self):

        self.router = ActionRouter()

    def execute(self, action):

        # Action dataclass ko dict me convert kar do
        if hasattr(action, "__dict__"):
            action = vars(action)

        try:

            result = self.router.execute(action)

            if hasattr(result, "success"):

                return ActionResult(

                    success=result.success,

                    action=action.get("action", ""),

                    message="Success" if result.success else "Failed",

                    data=result

                )

            return ActionResult(

                success=bool(result),

                action=action.get("action", ""),

                message="Success" if result else "Failed",

                data=result

            )

        except Exception as e:

            return ActionResult(

                success=False,

                action=action.get("action", ""),

                message=str(e),

                data=None

            )