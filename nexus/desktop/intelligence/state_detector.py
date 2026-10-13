import hashlib
import time

from perception import Screen


class StateDetector:

    def __init__(self):

        self.screen = Screen()

    def screenshot_hash(self):

        frame = self.screen.capture()

        return hashlib.md5(

            frame.image.tobytes()

        ).hexdigest()

    def wait_until_changed(

        self,

        timeout=10,

        interval=0.5

    ):

        start = self.screenshot_hash()

        t = time.time()

        while time.time() - t < timeout:

            current = self.screenshot_hash()

            if current != start:

                return True

            time.sleep(interval)

        return False