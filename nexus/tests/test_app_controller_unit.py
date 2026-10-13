from desktop.app_controller.controller import AppController


class FakeDiscovery:
    def discover(self, _name):
        return type("App", (), {"installed": True, "executable": "app.exe"})()


class FakeLauncher:
    def launch(self, _path): return True
    def close(self, _name): return True


class FakeWindows:
    def focus(self, _name): return True
    def minimize(self, _name): return True
    def maximize(self, _name): return True


class FakeProcesses:
    def exists(self, _name): return True
    def list_processes(self): return [{"name": "App.exe"}]


def test_app_lifecycle_routes_to_desktop_adapters():
    controller = AppController()
    controller.discovery, controller.launcher = FakeDiscovery(), FakeLauncher()
    controller.windows, controller.processes = FakeWindows(), FakeProcesses()
    assert controller.open_app("app")
    assert controller.is_running("app")
    assert controller.focus_app("app")
    assert controller.minimize_app("app")
    assert controller.maximize_app("app")
    assert controller.get_running_apps() == ["App.exe"]
