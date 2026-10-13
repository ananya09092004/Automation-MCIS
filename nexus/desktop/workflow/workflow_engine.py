import time

from desktop.executor.action_engine import ActionEngine


class WorkflowEngine:

    def __init__(self):

        self.engine = ActionEngine()

    def run(self, workflow):

        results = []

        for step in workflow:

            result = self.engine.execute(step)

            results.append(result)

            delay = step.get("delay", 0)

            if delay > 0:
                time.sleep(delay)

        return results