from browser.runtime.runtime import ExecutionRuntime
from browser.intelligence.replanner import Replanner


class ClosedLoopRuntime:

    def __init__(

        self,

        runtime: ExecutionRuntime,

        verifier,

        world_manager

    ):

        self.runtime = runtime

        self.verifier = verifier

        self.world = world_manager

        self.replanner = Replanner()

    def execute(

        self,

        plan,

        values=None,

        max_attempts=5

    ):

        if values is None:

            values = {}

        current_plan = plan

        attempts = 0

        while attempts < max_attempts:

            attempts += 1

            success = self.runtime.execute(

                current_plan,

                values

            )

            if not success:

                state = self.world.get()

                failed_action = None

                if current_plan.steps:
                    failed_action = current_plan.steps[-1].action

                result = self.replanner.replan(

                    state,

                    failed_action

                )

                if not result.recovered:

                    return False

                current_plan.steps = [

                    type(current_plan.steps[0])(action=a)

                    for a in result.new_actions
                ]

                continue

            verified = True

            for step in current_plan.steps:

                if not self.verifier.verify(step.action):

                    verified = False
                    break

            if verified:
                return True

            state = self.world.get()

            failed_action = None

            if current_plan.steps:
                failed_action = current_plan.steps[-1].action

            result = self.replanner.replan(

                state,

                failed_action

            )

            if not result.recovered:

                return False

            current_plan.steps = [

                type(current_plan.steps[0])(action=a)

                for a in result.new_actions
            ]

        return False