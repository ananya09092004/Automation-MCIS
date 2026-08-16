from dataclasses import dataclass, field

from .memory import Memory


@dataclass
class WorldState:

    user_goal: str = ""

    page_type: str = ""

    current_url: str = ""

    page_title: str = ""

    current_stage: str = ""

    next_stage: str = ""

    completed: bool = False

    observations: dict = field(default_factory=dict)

    memory: dict = field(default_factory=dict)

    errors: list = field(default_factory=list)

    history: list = field(default_factory=list)

    last_action: str = ""

    retry_count: int = 0

    confidence: float = 0.0


class WorldStateManager:

    def __init__(self):

        self.state = WorldState()

        self.memory_system = Memory()

    # ------------------------
    # STATE
    # ------------------------

    def get(self):

        return self.state

    def update(self, **kwargs):

        for key, value in kwargs.items():

            if hasattr(self.state, key):

                setattr(

                    self.state,

                    key,

                    value

                )

    # ------------------------
    # MEMORY
    # ------------------------

    def remember(

        self,

        key,

        value,

        source=""

    ):

        self.memory_system.remember(

            key,

            value,

            source

        )

        self.state.memory[key] = value

    def recall(

        self,

        key,

        default=None

    ):

        value = self.memory_system.recall(

            key,

            default

        )

        if value is not None:

            return value

        return self.state.memory.get(

            key,

            default

        )

    def forget(

        self,

        key

    ):

        self.memory_system.forget(

            key

        )

        self.state.memory.pop(

            key,

            None

        )

    # ------------------------
    # OBSERVATIONS
    # ------------------------

    def observe(

        self,

        key,

        value

    ):

        self.state.observations[key] = value

    # ------------------------
    # ERRORS
    # ------------------------

    def error(

        self,

        message

    ):

        self.state.errors.append(message)

    # ------------------------
    # HISTORY
    # ------------------------

    def add_history(

        self,

        action,

        success=True

    ):

        self.state.history.append(action)

        self.state.last_action = action

        self.memory_system.add_action(

            action,

            success

        )

    def last_history(self):

        if not self.state.history:

            return None

        return self.state.history[-1]

    # ------------------------
    # RETRY
    # ------------------------

    def increment_retry(self):

        self.state.retry_count += 1

    def reset_retry(self):

        self.state.retry_count = 0

    # ------------------------
    # CONFIDENCE
    # ------------------------

    def set_confidence(

        self,

        value

    ):

        self.state.confidence = value

    # ------------------------
    # RESET
    # ------------------------

    def reset(self):

        self.state = WorldState()

        self.memory_system.clear()