from dataclasses import dataclass, field
from collections import deque


@dataclass
class MemoryRecord:

    key: str

    value: object

    source: str = ""


class Memory:

    def __init__(

        self,

        history_size: int = 100

    ):

        self.facts = {}

        self.history = deque(maxlen=history_size)

    # ----------------------
    # Facts
    # ----------------------

    def remember(

        self,

        key,

        value,

        source=""

    ):

        self.facts[key] = MemoryRecord(

            key,

            value,

            source

        )

    def recall(

        self,

        key,

        default=None

    ):

        record = self.facts.get(key)

        if record is None:

            return default

        return record.value

    def forget(

        self,

        key

    ):

        self.facts.pop(

            key,

            None

        )

    # ----------------------
    # Action History
    # ----------------------

    def add_action(

        self,

        action,

        success=True

    ):

        self.history.append(

            {

                "action": action,

                "success": success

            }

        )

    def last_action(self):

        if not self.history:

            return None

        return self.history[-1]

    def all_actions(self):

        return list(self.history)

    def clear(self):

        self.facts.clear()

        self.history.clear()