import time

from desktop.application_manager.discovery import ApplicationDiscovery
from desktop.adapters.launcher import Launcher
from desktop.process_manager.controller import ProcessManager
from desktop.window_manager.manager import WindowManager


class AppController:

    def __init__(self):

        self.discovery = ApplicationDiscovery()
        self.launcher = Launcher()
        self.processes = ProcessManager()
        self.windows = WindowManager()

    def open_app(self, app_name: str) -> bool:

        # Was: always launched a brand-new process regardless of whether
        # the app was already running -- this is the root cause of
        # "duplicate actions"/"broken app switching": saying "open
        # Chrome" (or the router falling back to open_app for what was
        # really a "switch to Chrome" request) while Chrome was already
        # open spawned a SECOND Chrome instance/window instead of
        # switching to the existing one. fastPath.js's own comment
        # ("open_app() does its own dynamic discovery of whether an app
        # is running") documents this as the intended behavior -- it
        # just wasn't actually implemented here. If the app already has
        # a window, just focus it; only launch a new process when it
        # genuinely isn't running.
        if self.is_running(app_name) and self._bring_to_front(app_name, timeout=2.0):
            return True

        app = self.discovery.discover(app_name)

        if not app.installed:
            return False

        launched = self.launcher.launch(app.executable)

        if not launched:
            return False

        self._bring_to_front(app_name)

        return True

    def _bring_to_front(self, app_name: str, timeout: float = 6.0, interval: float = 0.2) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.windows.focus(app_name):
                return True
            time.sleep(interval)
        return False

    def is_running(self, app_name: str) -> bool:

        return self.processes.exists(app_name)

    def close_app(self, app_name: str):

        return self.launcher.close(app_name)

    def restart_app(self, app_name: str):

        if self.close_app(app_name):

            return self.open_app(app_name)

        return False

    def focus_app(self, app_name: str) -> bool:
        return self.windows.focus(app_name)

    def minimize_app(self, app_name: str) -> bool:
        return self.windows.minimize(app_name)

    def maximize_app(self, app_name: str) -> bool:
        return self.windows.maximize(app_name)

    def switch_to_app(self, app_name: str) -> bool:
        return self.focus_app(app_name)

    def get_running_apps(self) -> list[str]:
        return sorted({process["name"] for process in self.processes.list_processes() if process.get("name")})