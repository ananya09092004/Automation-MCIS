from desktop.window_manager.manager import WindowManager


class DesktopStateManager:

    def __init__(self):

        self.windows = WindowManager()

    def is_app_open(self, title: str):

        return self.windows.exists(title)

    def activate(self, title: str):

        return self.windows.focus(title)

    def ensure_window(self, title: str):

        if not self.is_app_open(title):

            return False

        self.activate(title)

        return True