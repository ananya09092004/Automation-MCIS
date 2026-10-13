from collections import deque


class ActionQueue:

    def __init__(self):

        self.queue = deque()

    def add(

        self,

        action

    ):

        self.queue.append(action)

    def get(self):

        if not self.queue:

            return None

        return self.queue.popleft()

    def clear(self):

        self.queue.clear()

    def size(self):

        return len(self.queue)

    def empty(self):

        return len(self.queue) == 0

    def peek(self):

        if self.empty():

            return None

        return self.queue[0]