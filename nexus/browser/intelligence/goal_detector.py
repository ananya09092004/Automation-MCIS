from dataclasses import dataclass

from browser.intelligence.world_state import WorldState


@dataclass
class GoalState:

    goal: str

    current_stage: str

    next_stage: str

    completed: bool = False

    confidence: float = 0.0


class GoalDetector:

    def detect(

        self,

        user_goal: str,

        state: WorldState

    ) -> GoalState:

        goal = user_goal.lower()

        page = state.page_type.lower()

        observations = state.observations or {}

        # ----------------------------
        # Login
        # ----------------------------

        if page == "login":

            return GoalState(

                goal=user_goal,

                current_stage="login",

                next_stage="authenticate",

                confidence=0.98

            )

        # ----------------------------
        # Search
        # ----------------------------

        if page == "search":

            return GoalState(

                goal=user_goal,

                current_stage="search",

                next_stage="collect_results",

                confidence=0.98

            )

        # ----------------------------
        # Shopping
        # ----------------------------

        if page == "shopping":

            return GoalState(

                goal=user_goal,

                current_stage="shopping",

                next_stage="select_item",

                confidence=0.95

            )

        # ----------------------------
        # Checkout
        # ----------------------------

        if page == "checkout":

            return GoalState(

                goal=user_goal,

                current_stage="checkout",

                next_stage="payment",

                confidence=0.95

            )

        # ----------------------------
        # Booking
        # ----------------------------

        if page == "booking":

            return GoalState(

                goal=user_goal,

                current_stage="booking",

                next_stage="fill_booking",

                confidence=0.95

            )

        # ----------------------------
        # Dashboard
        # ----------------------------

        if page == "dashboard":

            return GoalState(

                goal=user_goal,

                current_stage="dashboard",

                next_stage="execute_goal",

                confidence=0.90

            )

        # ----------------------------
        # Popup
        # ----------------------------

        if observations.get("dialog"):

            return GoalState(

                goal=user_goal,

                current_stage="dialog",

                next_stage="close_dialog",

                confidence=0.90

            )

        # ----------------------------
        # Loading
        # ----------------------------

        if observations.get("loading"):

            return GoalState(

                goal=user_goal,

                current_stage="loading",

                next_stage="wait",

                confidence=0.90

            )

        # ----------------------------
        # Error
        # ----------------------------

        if observations.get("error"):

            return GoalState(

                goal=user_goal,

                current_stage="error",

                next_stage="recover",

                confidence=0.90

            )

        # ----------------------------
        # Default
        # ----------------------------

        return GoalState(

            goal=user_goal,

            current_stage="observe",

            next_stage="analyze",

            confidence=0.40

        )