import time

from desktop.window_manager.manager import WindowManager


class WaitEngine:

    def __init__(self):

        self.window = WindowManager()

    def wait_for_window(
        self,
        title,
        timeout=15,
        interval=0.5
    ):

        start = time.time()

        while time.time() - start < timeout:

            if self.window.exists(title):

                return True

            time.sleep(interval)

        return False

    def focus(
        self,
        title
    ):

        return self.window.focus(title)