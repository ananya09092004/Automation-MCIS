from desktop.automation.models import Action


class DesktopTaskPlanner:

    def plan(
        self,
        command: str
    ) -> list[Action]:

        text = command.lower()

        actions = []

        self._plan_open_app(
            text,
            actions
        )

        self._plan_typing(
            command,
            actions
        )

        return actions

    def _plan_open_app(
        self,
        text,
        actions
    ):

        apps = {

            "notepad": "notepad",
            "calculator": "calc",
            "paint": "mspaint",
            "chrome": "chrome",
            "edge": "msedge",
            "vscode": "code"

        }

        for keyword, app in apps.items():

            if keyword in text:

                actions.append(

                    Action(

                        action="open_app",

                        app=app

                    )

                )

                break

    def _plan_typing(
        self,
        command,
        actions
    ):

        lower = command.lower()

        keywords = [

            "type",
            "write"

        ]

        for key in keywords:

            if key in lower:

                idx = lower.index(key)

                value = command[

                    idx + len(key):

                ].strip()

                if value:

                    actions.append(

                        Action(

                            action="type_text",

                            text=value

                        )

                    )

                break