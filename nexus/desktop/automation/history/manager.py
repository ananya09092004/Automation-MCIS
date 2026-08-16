from datetime import datetime


class HistoryManager:

    def __init__(self):

        self.clear()

    def clear(self):

        self._history = []

    def add(

        self,

        action,

        success,

        message=""

    ):

        self._history.append(

            {

                "time": datetime.now(),

                "action": action,

                "success": success,

                "message": message

            }

        )

    def all(self):

        return list(

            self._history

        )

    def last(self):

        if not self._history:

            return None

        return self._history[-1]

    def successful(self):

        return [

            h

            for h in self._history

            if h["success"]

        ]

    def failed(self):

        return [

            h

            for h in self._history

            if not h["success"]

        ]