class ConversationMemory:

    def __init__(self):

        self.history = []

    def remember(

        self,

        user,

        assistant

    ):

        self.history.append(

            {

                "user": user,

                "assistant": assistant

            }

        )

    def last(self):

        if self.history:

            return self.history[-1]

        return None