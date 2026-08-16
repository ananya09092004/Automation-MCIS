from planner.models import Action
from planner.parser import GoalParser


class Planner:

    def __init__(self):

        self.parser = GoalParser()

    def build(

        self,

        goal: str

    ) -> list[Action]:

        parsed = self.parser.parse(goal)

        plan = []

        # ---------------- LOGIN ----------------

        if parsed.intent == "login":

            plan.extend([

                Action(

                    action="observe",

                    description="Understand page"

                ),

                Action(

                    action="fill",

                    target="username"

                ),

                Action(

                    action="fill",

                    target="password"

                ),

                Action(

                    action="click",

                    target="login_button"

                )

            ])

        # ---------------- SEARCH ----------------

        elif parsed.intent == "search":

            plan.extend([

                Action(

                    action="observe"

                ),

                Action(

                    action="fill",

                    target="search",

                    value=parsed.value

                ),

                Action(

                    action="press",

                    target="search",

                    value="Enter"

                )

            ])

        # ---------------- SHOPPING ----------------

        elif parsed.intent == "shopping":

            plan.extend([

                Action(

                    action="observe"

                ),

                Action(

                    action="fill",

                    target="search",

                    value=parsed.value

                ),

                Action(

                    action="press",

                    target="search",

                    value="Enter"

                ),

                Action(

                    action="click",

                    target="first_result"

                )

            ])

        else:

            plan.append(

                Action(

                    action="observe"

                )

            )

        return plan