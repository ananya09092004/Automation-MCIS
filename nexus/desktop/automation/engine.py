from desktop.executor.executor import DesktopExecutor


class AutomationEngine:

    def __init__(self):

        self.executor = DesktopExecutor()

    def run(

        self,

        actions

    ):

        results = []

        for action in actions:

            result = self.executor.execute(

                action

            )

            results.append(result)

        return results