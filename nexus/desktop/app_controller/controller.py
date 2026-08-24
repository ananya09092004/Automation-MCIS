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