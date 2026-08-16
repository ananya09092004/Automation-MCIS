from dataclasses import dataclass

from .world_state import WorldState


@dataclass
class Decision:

    action: str

    reason: str

    confidence: float


class DecisionEngine:

    def decide(

        self,

        state: WorldState

    ) -> Decision:

        observations = state.observations or {}

        # ---------------- GOAL COMPLETED ----------------

        if state.completed:

            return Decision(

                action="finish",

                reason="Goal completed",

                confidence=1.0

            )

        # ---------------- LOADING ----------------

        if observations.get("loading"):

            return Decision(

                action="wait",

                reason="Page is loading",

                confidence=0.99

            )

        # ---------------- ERROR ----------------

        if observations.get("error"):

            return Decision(

                action="recover",

                reason="Error detected",

                confidence=0.95

            )

        # ---------------- DIALOG ----------------

        if observations.get("dialog"):

            return Decision(

                action="handle_dialog",

                reason="Dialog detected",

                confidence=0.90

            )

        # ---------------- STAGE BASED ----------------

        stage = state.current_stage

        stage_actions = {

            "login": "authenticate",

            "search": "search",

            "shopping": "select_item",

            "checkout": "review_checkout",

            "booking": "book",

            "email": "compose",

            "settings": "modify_settings",

            "chat": "send_message",

            "documentation": "read",

            "reading": "continue_reading",

            "loading": "wait",

            "error": "recover",

            "unknown": "observe"

        }

        if stage in stage_actions:

            return Decision(

                action=stage_actions[stage],

                reason=f"Stage = {stage}",

                confidence=0.90

            )

        # ---------------- INTERACTIVE PAGE ----------------

        if observations.get("interactive", 0) > 20:

            return Decision(

                action="explore",

                reason="Highly interactive page",

                confidence=0.70

            )

        # ---------------- DEFAULT ----------------

        return Decision(

            action="observe",

            reason="Need more information",

            confidence=0.50

        )