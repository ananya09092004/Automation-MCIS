from browser.intelligence.world_state import WorldStateManager
from browser.intelligence.world_updater import WorldUpdater
from browser.intelligence.goal_progress import GoalProgressEvaluator
from browser.intelligence.decision import DecisionEngine
from browser.intelligence.action_selector import ActionSelector
from browser.intelligence.execution_planner import ExecutionPlanner
from browser.intelligence.replanner import Replanner

from browser.execution.action_executor import ActionExecutor


class ExecutionPipeline:

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

        self.replanner = Replanner()

    def execute(
        self,
        values=None,
        max_iterations=10
    ):

        if values is None:
            values = {}

        results = []

        previous_url = ""
        previous_stage = ""
        previous_action = None

        for iteration in range(max_iterations):

            print(
                f"\n========== PIPELINE ITERATION {iteration + 1} =========="
            )

            # --------------------------------
            # Observe
            # --------------------------------

            state = self.world.update()

            state = self.goal.evaluate(state)

            print("PAGE TYPE :", state.page_type)
            print("STAGE     :", state.current_stage)
            print("COMPLETED :", state.completed)

            # --------------------------------
            # Goal completed
            # --------------------------------

            if state.completed:

                print("\nGOAL COMPLETED")

                return state, results

            # --------------------------------
            # Detect no progress
            # --------------------------------

            if (
                state.current_url == previous_url
                and
                state.current_stage == previous_stage
                and
                previous_action is not None
            ):

                print(
                    "\nNO PROGRESS DETECTED"
                )

                print(
                    "Pipeline stopped to prevent infinite loop."
                )

                return state, results

            previous_url = state.current_url
            previous_stage = state.current_stage

            # --------------------------------
            # Decide
            # --------------------------------

            decision = self.decision.decide(state)

            print(
                "DECISION :", decision.action
            )

            # --------------------------------
            # Select actions
            # --------------------------------

            browser_actions = self.selector.select(
                decision
            )

            # --------------------------------
            # Build plan
            # --------------------------------

            execution_plan = self.planner.build(
                browser_actions.actions
            )

            # --------------------------------
            # Execute
            # --------------------------------

            failed = False

            for step in execution_plan.steps:

                action = step.action

                previous_action = action.action

                # Inject runtime values
                if (
                    action.action == "fill"
                    and
                    not action.value
                ):

                    if action.target in values:

                        action.value = values[
                            action.target
                        ]

                result = self.executor.execute(
                    action
                )

                results.append(result)

                self.world_manager.remember(
                    "last_action",
                    action.action
                )

                # --------------------------------
                # Action failed
                # --------------------------------

                if not result:

                    print(
                        "\nACTION FAILED"
                    )

                    state = self.world.update()

                    replan = self.replanner.replan(
                        state,
                        action
                    )

                    print(
                        "REPLAN :",
                        replan.reason
                    )

                    if not replan.recovered:

                        self.world_manager.error(
                            replan.reason
                        )

                        return state, results

                    # Execute recovery actions
                    # Execute recovery actions
                    for recovery_action in replan.new_actions:

                        # Recovery actions created by Replanner may not
                        # carry the runtime value. Inject it here.
                        if (
                            recovery_action.action == "fill"
                            and not recovery_action.value
                        ):

                            if recovery_action.target in values:

                                recovery_action.value = values[
                                    recovery_action.target
                                ]

                        retry = self.executor.execute(
                            recovery_action
                        )

                        results.append(
                            retry
                        )

                        if not retry:

                            self.world_manager.error(
                                "Recovery action failed"
                            )

                            return state, results

                    failed = True
                    break

            # --------------------------------
            # Refresh world after execution
            # --------------------------------

            state = self.world.update()

            state = self.goal.evaluate(state)

            if state.completed:

                print(
                    "\nGOAL COMPLETED"
                )

                return state, results

            # --------------------------------
            # If recovery happened, observe
            # again instead of blindly repeating
            # --------------------------------

            if failed:

                continue

        # --------------------------------
        # Maximum iteration reached
        # --------------------------------

        state = self.world.update()

        state = self.goal.evaluate(state)

        self.world_manager.error(
            "Maximum pipeline iterations reached"
        )

        print(
            "\nPIPELINE STOPPED:"
            " maximum iterations reached"
        )

        return state, results