from desktop.window_manager.manager import WindowManager


class RecoveryEngine:

    def __init__(self):

        self.windows = WindowManager()

    def recover(self, action):

        name = action.action

        if name == "type_text":

            return self._recover_typing(action)

        if name == "click":

            return True

        if name == "open_app":

            return True

        return False

    def _recover_typing(self, action):

        if not action.title:

            return False

        return self.windows.focus(

            action.title

        )