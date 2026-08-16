"""Windows UI Automation adapter.

It is intentionally optional: when an app exposes no accessibility tree, the
desktop target executor falls back to OCR rather than failing at import time.
"""

from typing import Any


class WindowsUIAutomation:
    def __init__(self):
        try:
            from pywinauto import Desktop
        except ImportError:
            self.desktop = None
        else:
            self.desktop = Desktop(backend="uia")

    @property
    def available(self) -> bool:
        return self.desktop is not None

    def find(self, target: dict[str, Any]):
        if not self.desktop:
            return None
        criteria = {}
        if target.get("window_title"):
            criteria["title_re"] = target["window_title"]
        if target.get("title"):
            criteria["title"] = target["title"]
        if target.get("control_type"):
            criteria["control_type"] = target["control_type"]
        if target.get("automation_id"):
            criteria["auto_id"] = target["automation_id"]
        if not criteria:
            raise ValueError("Desktop target needs window_title, title, control_type, or automation_id.")
        try:
            element = self.desktop.window(**criteria)
            element.wait("exists ready", timeout=target.get("timeout", 8))
            return element.wrapper_object()
        except Exception:
            return None

    def click(self, element) -> bool:
        try:
            element.click_input()
            return True
        except Exception:
            return False

    def fill(self, element, value: str) -> bool:
        try:
            element.set_edit_text(value)
            return True
        except Exception:
            return False

    def read_text(self, element) -> str:
        try:
            return element.window_text()
        except Exception:
            return ""
