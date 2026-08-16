from dataclasses import dataclass, field


@dataclass
class BrowserAction:

    action: str

    target: str = ""

    value: str = ""


@dataclass
class ActionPlan:

    actions: list[BrowserAction] = field(default_factory=list)


class ActionSelector:

    def select(

        self,

        decision,

        context=None

    ) -> ActionPlan:

        if context is None:

            context = {}

        plan = ActionPlan()

        if decision.action == "authenticate":

            plan.actions.extend(

                [

                    BrowserAction(

                        action="fill",

                        target="username",

                        value=context.get(

                            "username",

                            ""

                        )

                    ),

                    BrowserAction(

                        action="fill",

                        target="password",

                        value=context.get(

                            "password",

                            ""

                        )

                    ),

                    BrowserAction(

                        action="click",

                        target="login_button"

                    )

                ]

            )

            return plan

        if decision.action == "search":

            plan.actions.extend(

                [

                    BrowserAction(

                        action="fill",

                        target="search_box"

                    ),

                    BrowserAction(

                        action="press",

                        target="enter"

                    )

                ]

            )

            return plan

        if decision.action == "recover":

            plan.actions.append(

                BrowserAction(

                    action="observe"

                )

            )

            return plan

        plan.actions.append(

            BrowserAction(

                action="observe"

            )

        )

        return plan