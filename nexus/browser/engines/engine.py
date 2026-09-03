from playwright.sync_api import sync_playwright
from pathlib import Path
import atexit


class BrowserEngine:

    def __init__(self):

        self.playwright = None
        self.browser = None
        self.context = None
        self.storage_state_path = None
        self._atexit_registered = False

    def start(

        self,

        browser_name="chromium",

        headless=False,
        storage_state_path=None

    ):

        if self.browser is not None:

            return self.browser

        self.playwright = sync_playwright().start()

        browser_name = browser_name.lower()

        launch_options = {"headless": headless}

        if browser_name in {"chromium", "chrome"}:

            launcher = self.playwright.chromium
            if browser_name == "chrome":
                launch_options["channel"] = "chrome"

        elif browser_name == "edge":

            launcher = self.playwright.chromium
            launch_options["channel"] = "msedge"

        elif browser_name == "firefox":

            launcher = self.playwright.firefox

        elif browser_name == "webkit":

            launcher = self.playwright.webkit

        else:

            raise ValueError(

                f"Unsupported browser: {browser_name}"

            )

        self.browser = launcher.launch(**launch_options)

        self.storage_state_path = storage_state_path
        if storage_state_path:
            Path(storage_state_path).parent.mkdir(parents=True, exist_ok=True)
        options = {"storage_state": storage_state_path} if storage_state_path and Path(storage_state_path).is_file() else {}
        self.context = self.browser.new_context(**options)

        if not self._atexit_registered:
            # Safety net for the case the process is interrupted
            # (Ctrl+C, terminal closed) without an explicit "close
            # browser"/stop() ever running -- without this, any login
            # that happened during this run (e.g. the user just signed
            # into Gmail) would never get written to the session file,
            # so requirement 4 ("on stop/close, save session state")
            # wouldn't actually hold for the common "just closed the
            # window" case. Registered once per engine instance; safe
            # to call even if stop() already ran (it's a no-op then).
            def _safe_stop_at_exit():
                try:
                    self.stop()
                except Exception:
                    pass  # interpreter is already shutting down -- never raise from atexit
            atexit.register(_safe_stop_at_exit)
            self._atexit_registered = True

        return self.browser

    def stop(self):

        if self.context:

            if self.storage_state_path:
                self.context.storage_state(path=self.storage_state_path)

            self.context.close()

            self.context = None
            self.storage_state_path = None

        if self.browser:

            self.browser.close()

            self.browser = None

        if self.playwright:

            self.playwright.stop()

            self.playwright = None

    def restart(

        self,

        browser_name="chromium",

        headless=False

    ):

        self.stop()

        return self.start(

            browser_name,

            headless

        )

    def is_running(self):

        return self.browser is not None

    def new_page(self):

        if self.context is None:

            raise RuntimeError(

                "Browser not started."

            )

        return self.context.new_page()

    def new_context(self):

        if self.browser is None:

            raise RuntimeError(

                "Browser not started."

            )

        self.context = self.browser.new_context()

        return self.context

    def current_browser(self):

        return self.browser