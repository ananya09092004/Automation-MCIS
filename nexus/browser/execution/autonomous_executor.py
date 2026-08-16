import time


from browser.intelligence.world_updater import WorldUpdater
from browser.intelligence.goal_progress import GoalProgressEvaluator
from browser.intelligence.decision import DecisionEngine
from browser.intelligence.action_selector import ActionSelector
from browser.intelligence.execution_planner import ExecutionPlanner
from browser.intelligence.world_state import WorldStateManager
from browser.execution.action_executor import ActionExecutor

class AutonomousExecutor:

    def __init__(self, page):

        self.page = page

        self.world_manager = WorldStateManager()

        self.world = WorldUpdater(
            page,
            self.world_manager
        )

        self.goal = GoalProgressEvaluator()

        self.decision = DecisionEngine()

        self.selector = ActionSelector()

        self.planner = ExecutionPlanner()

        self.executor = ActionExecutor(page)

    def run(

        self,

        state=None,

        context=None,

        max_iterations=30

    ):

        if context is None:

            context = {}

        iterations = 0
        last_page = None
        same_page_count = 0

        while iterations < max_iterations:

            iterations += 1

            # Agar external state di gayi hai (tests)
            if state is not None:

                self.world_manager.state = state

            # Fresh world update
            state = self.world.update()

            # Goal progress update
            state = self.goal.evaluate(state)

            if state.completed:

                return True

            # Decision
            decision = self.decision.decide(state)

            # Browser Actions
            action_plan = self.selector.select(

                decision,

                context

            )

            # Validate required values
            for action in action_plan.actions:

                if (
                    action.action == "fill"
                    and
                    action.value == ""
                ):

                    raise ValueError(
                        f"Missing value for '{action.target}'"
                    )


            # Execution Plan
            execution_plan = self.planner.build(
                action_plan.actions
            )



            for step in execution_plan.steps:

                success = self.executor.execute(step.action)

                if not success:
                    return False

            # Browser ko page update karne ka time do
            time.sleep(1)

            current_url = self.page.url

            if current_url == last_page:

                same_page_count += 1

            else:

                same_page_count = 0

            last_page = current_url

            # Agar 3 baar same page raha to ruk jao
            if same_page_count >= 3:

                return False
        return False