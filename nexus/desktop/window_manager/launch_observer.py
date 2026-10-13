"""Find the actual UI window created by an app launcher, even after process handoff."""

from time import monotonic, sleep


class LaunchObserver:
    def snapshot(self) -> set[int]:
        from pywinauto import Desktop
        return {window.handle for window in Desktop(backend="uia").windows() if window.is_visible()}

    def wait_for_new_window(self, title_fragment: str, before_handles: set[int], timeout: float = 10):
        from pywinauto import Desktop

        deadline = monotonic() + timeout
        expected = title_fragment.casefold()
        while monotonic() < deadline:
            for window in Desktop(backend="uia").windows():
                try:
                    if (window.handle not in before_handles and window.is_visible()
                            and expected in window.window_text().casefold()):
                        return window
                except Exception:
                    continue
            sleep(0.25)
        return None
