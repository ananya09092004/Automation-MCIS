from desktop.automation.queue import ActionQueue

from desktop.automation.models import Action


queue = ActionQueue()

queue.add(

    Action(

        action="open_app",

        app="chrome"

    )

)

queue.add(

    Action(

        action="type_text",

        text="Hello"

    )

)

print(queue.size())

print(queue.peek())

print(queue.get())

print(queue.size())

print(queue.empty())

queue.clear()

print(queue.empty())