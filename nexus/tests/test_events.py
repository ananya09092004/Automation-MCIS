import time

from desktop.automation.events import EventManager


event = EventManager()

start = time.time()


def condition():

    return time.time() - start >= 3


print(

    event.wait_until(

        condition,

        timeout=5

    )

)