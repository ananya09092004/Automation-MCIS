import time


class EventManager:

    def wait_until(

        self,

        condition,

        timeout=30,

        interval=0.5

    ):

        start = time.time()

        while time.time() - start < timeout:

            if condition():

                return True

            time.sleep(interval)

        return False