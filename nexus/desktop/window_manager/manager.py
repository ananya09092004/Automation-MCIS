import pygetwindow as gw
import win32gui
import win32con


def _safe_foreground(hwnd) -> bool:
    """Robust foreground-activation fallback for when pygetwindow's own
    window.activate() raises (see focus() below). Restores the window if
    minimized, then asks Windows to bring it to the foreground directly
    via win32gui. This can ALSO fail -- Windows deliberately blocks a
    background process from stealing focus unless the calling process
    was the one that last had the user's input focus (the same
    restriction that makes window.activate() unreliable in the first
    place) -- so this is a best-effort second attempt, not a guarantee,
    and any failure here is caught by the caller rather than raised."""
    try:
        if win32gui.IsIconic(hwnd):
            win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        win32gui.SetForegroundWindow(hwnd)
        return True
    except Exception:
        return False


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

        # window.activate() is a thin pygetwindow wrapper around Windows'
        # SetForegroundWindow, which Windows deliberately refuses for a
        # background process in many real situations (foreground-lock
        # restriction) -- when that happens, pygetwindow/pywin32 doesn't
        # just return False, it RAISES pywintypes.error, and that error's
        # message frequently renders as something like "The system
        # cannot find the file specified" (WinError 2) even though this
        # has nothing to do with a missing file. Uncaught, that exception
        # was propagating all the way up to the action's top-level error
        # handler and being reported as if the whole open/focus action
        # had failed -- even when the target app had genuinely launched
        # and was sitting right there on the taskbar. Catch it here and
        # try a second, more direct activation path instead of letting
        # it blow up the entire action.
        try:
            window.activate()
            return True
        except Exception:
            try:
                hwnd = window._hWnd
            except AttributeError:
                hwnd = None
            if hwnd and _safe_foreground(hwnd):
                return True
            # Both activation paths failed -- genuinely could not bring
            # this window forward (e.g. foreground-lock blocked both).
            # Return False so the caller's normal retry/timeout loop
            # (AppController._bring_to_front) keeps trying, instead of
            # crashing the whole open_app call on the first attempt.
            return False

    def maximize(
        self,
        title: str
    ) -> bool:

        windows = gw.getWindowsWithTitle(
            title
        )

        if not windows:

            return False

        try:
            windows[0].maximize()
            return True
        except Exception:
            return False

    def minimize(
        self,
        title: str
    ) -> bool:

        windows = gw.getWindowsWithTitle(
            title
        )

        if not windows:

            return False

        try:
            windows[0].minimize()
            return True
        except Exception:
            return False

    def close(
        self,
        title: str
    ) -> bool:

        windows = gw.getWindowsWithTitle(
            title
        )

        if not windows:

            return False

        try:
            windows[0].close()
            return True
        except Exception:
            return False

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

        try:
            windows[0].restore()
            return True
        except Exception:
            return False

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