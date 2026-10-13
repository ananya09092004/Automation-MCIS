import time

from desktop.automation.state import DesktopStateManager


class ActionVerifier:

    def __init__(self):

        self.state = DesktopStateManager()

    def verify(self, action):

        name = action.action

        if name == "open_app":

            return self.verify_open_app(

                action.app

            )

        return True

    def verify_open_app(

        self,

        app,

        timeout=10

    ):

        start = time.time()

        while time.time() - start < timeout:

            if self.state.is_app_open(app):

                return True

            time.sleep(0.5)

        return False