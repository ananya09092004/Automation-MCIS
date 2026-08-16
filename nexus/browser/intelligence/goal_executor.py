from dataclasses import dataclass


@dataclass
class GoalResult:

    completed: bool

    iterations: int

    reason: str = ""


class GoalExecutor:

    def __init__(

        self,

        world_updater,

        goal_progress,

        decision_engine,

        action_selector,

        planner,

        runtime,

        verifier,

        replanner,

        world_manager

    ):

        self.world_updater = world_updater

        self.goal_progress = goal_progress

        self.decision_engine = decision_engine

        self.action_selector = action_selector

        self.planner = planner

        self.runtime = runtime

        self.verifier = verifier

        self.replanner = replanner

        self.world = world_manager

    def execute(

        self,

        values=None,

        max_iterations=50

    ) -> GoalResult:

        if values is None:

            values = {}

        iteration = 0

        while iteration < max_iterations:

            iteration += 1

            # ---------------------------------
            # Observe current world
            # ---------------------------------

            state = self.world_updater.update()

            state = self.goal_progress.evaluate(state)

            if state.completed:

                return GoalResult(

                    completed=True,

                    iterations=iteration,

                    reason="Goal completed"

                )

            # ---------------------------------
            # Decide next action
            # ---------------------------------

            decision = self.decision_engine.decide(

                state

            )

            # ---------------------------------
            # Convert decision -> browser actions
            # ---------------------------------

            action_set = self.action_selector.select(

                decision

            )

            if not action_set.actions:

                return GoalResult(

                    completed=False,

                    iterations=iteration,

                    reason="No executable actions"

                )

            # ---------------------------------
            # Build execution plan
            # ---------------------------------

            plan = self.planner.build(

                action_set.actions

            )

            # ---------------------------------
            # Execute
            # ---------------------------------

            success = self.runtime.execute(

                plan,

                values

            )

            if not success:

                self.world.error(

                    "Execution failed"

                )

                self.replanner.replan(

                    self.world.get()

                )

                continue

            # ---------------------------------
            # Verify execution
            # ---------------------------------

            verified = self.verifier.verify(

                plan

            )

            if not verified:

                self.world.error(

                    "Verification failed"

                )

                self.replanner.replan(

                    self.world.get()

                )

                continue

        return GoalResult(

            completed=False,

            iterations=max_iterations,

            reason="Maximum iterations reached"

        )