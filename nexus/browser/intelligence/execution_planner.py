from dataclasses import dataclass, field

from .action_selector import BrowserAction


@dataclass
class ExecutionStep:

    step: int

    action: BrowserAction

    verify: bool = True


@dataclass
class ExecutionPlan:

    steps: list[ExecutionStep] = field(default_factory=list)


class ExecutionPlanner:

    def build(

        self,

        actions: list[BrowserAction]

    ) -> ExecutionPlan:

        plan = ExecutionPlan()

        for index, action in enumerate(actions, start=1):

            plan.steps.append(

                ExecutionStep(

                    step=index,

                    action=action,

                    verify=True

                )

            )

        return plan