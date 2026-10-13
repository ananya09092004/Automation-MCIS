from common import ExecutionAction
from desktop.platform_executor import DesktopPlatformExecutor
from types import SimpleNamespace


class FakeAccessibility:
    def __init__(self):
        self.calls = []

    def click(self, target):
        self.calls.append(("click", target))
        return SimpleNamespace(method="uia", name="Save")

    def fill(self, target, value):
        self.calls.append(("fill", target, value))
        return SimpleNamespace(method="uia", name="Name")

    def read(self, target):
        return "hello", SimpleNamespace(method="uia", name="Body")

    def exists(self, target):
        return True


class FakeRouter:
    def execute(self, payload):
        return True


def test_desktop_target_actions_use_accessibility_driver():
    driver = FakeAccessibility()
    executor = DesktopPlatformExecutor(router=FakeRouter(), accessibility=driver)
    result = executor.execute(ExecutionAction(
        platform="desktop", action="fill_target",
        target={"window_title": "Notepad", "name": "Text Editor", "control_type": "Edit"},
        value="Hello Nexus",
    ))
    assert result.success
    assert result.evidence["method"] == "uia"
    assert driver.calls == [("fill", result.data and {"window_title": "Notepad", "name": "Text Editor", "control_type": "Edit"}, "Hello Nexus")]
