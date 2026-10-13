from desktop.automation.planner import DesktopTaskPlanner


class WorkflowPlanner:

    def __init__(self):

        self.desktop = DesktopTaskPlanner()

    def plan(
        self,
        command: str
    ):

        parts = [

            p.strip()

            for p in command.split(" and ")

            if p.strip()

        ]

        actions = []

        for part in parts:

            actions.extend(

                self.desktop.plan(part)

            )

        return actions