from browser.intelligence.world_state import WorldState


class GoalProgressEvaluator:

    def evaluate(

        self,

        state: WorldState

    ) -> WorldState:

        observations = state.observations or {}

        page_type = state.page_type

        # ---------------- LOADING ----------------

        if observations.get("loading"):

            state.current_stage = "loading"

            state.next_stage = None

            state.completed = False

            return state

        # ---------------- LOGIN ----------------

        if page_type == "login":

            state.current_stage = "login"

            state.next_stage = "authenticate"

            state.completed = False

            return state

        # ---------------- ERROR ----------------

        if observations.get("error"):

            state.current_stage = "error"

            state.next_stage = "recover"

            state.completed = False

            return state

        # ---------------- AUTHENTICATED ----------------

        if page_type in (

            "dashboard",

            "secure"

        ):

            state.current_stage = "authenticated"

            state.next_stage = None

            state.completed = True

            return state

        # ---------------- SEARCH ----------------

        if page_type == "search":

            state.current_stage = "search"

            state.next_stage = "results"

            state.completed = False

            return state

        # ---------------- SHOPPING ----------------

        if page_type == "shopping":

            state.current_stage = "shopping"

            state.next_stage = "select_product"

            state.completed = False

            return state

        # ---------------- CHECKOUT ----------------

        if page_type == "checkout":

            state.current_stage = "checkout"

            state.next_stage = "payment"

            state.completed = False

            return state

        # ---------------- BOOKING ----------------

        if page_type == "booking":

            state.current_stage = "booking"

            state.next_stage = "confirmation"

            state.completed = False

            return state

        # ---------------- EMAIL ----------------

        if page_type == "email":

            state.current_stage = "email"

            state.next_stage = "compose"

            state.completed = False

            return state

        # ---------------- SETTINGS ----------------

        if page_type == "settings":

            state.current_stage = "settings"

            state.next_stage = "modify"

            state.completed = False

            return state

        # ---------------- CHAT ----------------

        if page_type == "chat":

            state.current_stage = "chat"

            state.next_stage = "send_message"

            state.completed = False

            return state

        # ---------------- DOCUMENTATION ----------------

        if page_type == "documentation":

            state.current_stage = "documentation"

            state.next_stage = "read"

            state.completed = False

            return state

        # ---------------- ARTICLE ----------------

        if page_type == "article":

            state.current_stage = "reading"

            state.next_stage = "finish"

            state.completed = False

            return state

        # ---------------- UNKNOWN ----------------

        state.current_stage = "unknown"

        state.next_stage = "observe"

        state.completed = False

        return state