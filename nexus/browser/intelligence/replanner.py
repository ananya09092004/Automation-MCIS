from dataclasses import dataclass

from planner.models import Action

from .world_state import WorldState


@dataclass
class ReplanResult:

    recovered: bool

    new_actions: list[Action]

    reason: str


class Replanner:

    def replan(

        self,

        state: WorldState,

        failed_action: Action

    ) -> ReplanResult:

        observations = state.observations or {}

        page = state.page_type

        actions = []

        # ------------------------

        # Loading

        # ------------------------

        if observations.get("loading"):

            actions.append(

                Action(

                    action="wait",

                    description="Wait until loading finishes"

                )

            )

            return ReplanResult(

                True,

                actions,

                "Page still loading"

            )

        # ------------------------

        # Popup / Dialog

        # ------------------------

        if observations.get("dialog"):

            actions.append(

                Action(

                    action="close_dialog"

                )

            )

            actions.append(

                failed_action

            )

            return ReplanResult(

                True,

                actions,

                "Popup interrupted execution"

            )

        # ------------------------

        # Login appeared

        # ------------------------

        if page == "login":

            actions.extend([

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

                ),

                failed_action

            ])

            return ReplanResult(

                True,

                actions,

                "Authentication required"

            )

        # ------------------------

        # Error page

        # ------------------------

        if observations.get("error"):

            actions.append(

                Action(

                    action="refresh"

                )

            )

            actions.append(

                failed_action

            )

            return ReplanResult(

                True,

                actions,

                "Recover from error"

            )

        # ------------------------

        # Unknown

        # ------------------------

        actions.append(

            Action(

                action="observe"

            )

        )

        return ReplanResult(

            False,

            actions,

            "Need fresh observation"

        )