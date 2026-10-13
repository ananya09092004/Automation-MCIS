from dataclasses import dataclass

from browser.intelligence.world_state import WorldState
from planner.models import Action


@dataclass
class VerificationResult:

    success: bool

    reason: str


class RuntimeVerifier:

    def verify(

        self,

        state_before: WorldState,

        state_after: WorldState,

        action: Action

    ) -> VerificationResult:

        # Page changed
        if state_before.current_url != state_after.current_url:

            return VerificationResult(

                True,

                "Navigation successful"

            )

        # Title changed
        if state_before.page_title != state_after.page_title:

            return VerificationResult(

                True,

                "Page title changed"

            )

        # Goal completed
        if state_after.completed:

            return VerificationResult(

                True,

                "Goal completed"

            )

        # Login success
        if (

            state_before.page_type == "login"

            and

            state_after.page_type != "login"

        ):

            return VerificationResult(

                True,

                "Authenticated"

            )

        # Search results
        if (

            action.action == "search"

            and

            state_after.page_type != "search"

        ):

            return VerificationResult(

                True,

                "Search completed"

            )

        # Popup disappeared
        if (

            state_before.observations.get("dialog")

            and

            not state_after.observations.get("dialog")

        ):

            return VerificationResult(

                True,

                "Dialog closed"

            )

        # Loading finished
        if (

            state_before.observations.get("loading")

            and

            not state_after.observations.get("loading")

        ):

            return VerificationResult(

                True,

                "Loading finished"

            )

        return VerificationResult(

            False,

            "No observable state change"

        )