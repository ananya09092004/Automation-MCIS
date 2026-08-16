import pygetwindow as gw
import win32gui

class WindowManager:

    def exists(
        self,
        title: str
    ) -> bool:

        return len(
            gw.getWindowsWithTitle(title)
        ) > 0

    def focus(
        self,
        title: str
    ) -> bool:

        windows = gw.getWindowsWithTitle(
            title
        )

        if not windows:

            return False

        window = windows[0]

        window.activate()

        return True

    def maximize(
        self,
        title: str
    ) -> bool:

        windows = gw.getWindowsWithTitle(
            title
        )

        if not windows:

            return False

        windows[0].maximize()

        return True

    def minimize(
        self,
        title: str
    ) -> bool:

        windows = gw.getWindowsWithTitle(
            title
        )

        if not windows:

            return False

        windows[0].minimize()

        return True

    def close(
        self,
        title: str
    ) -> bool:

        windows = gw.getWindowsWithTitle(
            title
        )

        if not windows:

            return False

        windows[0].close()

        return True

    def active_window(self):

        hwnd = win32gui.GetForegroundWindow()

        return win32gui.GetWindowText(hwnd)

    def restore(
        self,
        title: str
    ) -> bool:

        windows = gw.getWindowsWithTitle(title)

        if not windows:

            return False

        windows[0].restore()

        return True

    def list_windows(self):

        return [

            w.title

            for w in gw.getAllWindows()

            if w.title.strip()

        ]

    def find(
        self,
        keyword: str
    ):

        keyword = keyword.lower()

        for window in gw.getAllWindows():

            if keyword in window.title.lower():

                return window.title

        return None