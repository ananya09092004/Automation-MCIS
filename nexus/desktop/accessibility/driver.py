"""Windows UI Automation driver with an OCR fallback for inaccessible apps."""

from dataclasses import dataclass
from time import monotonic, sleep
from typing import Any


class TargetNotFoundError(LookupError):
    pass


@dataclass
class TargetEvidence:
    method: str
    name: str
    control_type: str | None = None
    confidence: float | None = None
    x: int | None = None
    y: int | None = None


class DesktopAccessibilityDriver:
    """Locate visible controls by accessible name/id before using screen OCR.

    Target examples:
    {"window_title": "Notepad", "name": "File", "control_type": "MenuItem"}
    {"window_title": "Save As", "automation_id": "1001", "control_type": "Edit"}
    """

    def __init__(self, ocr_fallback=True):
        self.ocr_fallback = ocr_fallback

    def click(self, target: dict[str, Any]) -> TargetEvidence:
        control = self._find_accessible(target)
        if control is not None:
            control.click_input()
            return self._evidence(control, "uia")
        if target.get("image_path"):
            return self._image_click(target)
        return self._ocr_click(target)

    def fill(self, target: dict[str, Any], value: str) -> TargetEvidence:
        control = self._find_accessible(target)
        if control is None:
            if target.get("image_path"):
                evidence = self._image_click(target)
                import pyautogui
                pyautogui.write(value, interval=0.02)
                return evidence
            return self._ocr_fill(target, value)
        try:
            control.set_edit_text(value)
        except Exception:
            control.click_input()
            control.type_keys(value, with_spaces=True, set_foreground=True)
        return self._evidence(control, "uia")

    def read(self, target: dict[str, Any]) -> tuple[str, TargetEvidence]:
        control = self._find_accessible(target)
        if control is None:
            raise TargetNotFoundError(self._description(target))
        return control.window_text(), self._evidence(control, "uia")

    def exists(self, target: dict[str, Any]) -> bool:
        return self._find_accessible(target) is not None

    def wait_for(self, target: dict[str, Any], timeout: float = 10) -> TargetEvidence:
        deadline = monotonic() + timeout
        while monotonic() < deadline:
            control = self._find_accessible({**target, "timeout": 1})
            if control is not None:
                return self._evidence(control, "uia")
            sleep(0.2)
        raise TargetNotFoundError(self._description(target))

    def inspect_window(self, window_title: str, max_controls: int = 250) -> list[dict[str, Any]]:
        """Return visible, safe metadata for controls in any UIA-enabled app window."""
        try:
            from pywinauto import Desktop
            window = Desktop(backend="uia").window(title_re=window_title).wrapper_object()
        except Exception as error:
            raise TargetNotFoundError(window_title) from error
        result = []
        for control in window.descendants()[:max_controls]:
            try:
                if not control.is_visible():
                    continue
                info = control.element_info
                result.append({
                    "name": control.window_text(), "control_type": info.control_type,
                    "automation_id": info.automation_id, "class_name": info.class_name,
                    "enabled": control.is_enabled(),
                })
            except Exception:
                continue
        return result

    def _find_accessible(self, target: dict[str, Any]):
        try:
            from pywinauto import Desktop
        except ImportError as error:
            raise RuntimeError("pywinauto is required for Windows UI Automation.") from error

        window_title = target.get("window_title") or target.get("app")
        window_handle = target.get("window_handle")
        if not window_title and window_handle is None:
            raise ValueError("Desktop target requires 'window_title', 'app', or 'window_handle'.")
        try:
            # A handle is the safest scope when multiple windows share a title,
            # such as several Notepad documents or browser tabs.
            window = (Desktop(backend="uia").window(handle=int(window_handle))
                      if window_handle is not None
                      else Desktop(backend="uia").window(title_re=window_title))
            kwargs = {}
            if target.get("name"):
                kwargs["title"] = target["name"]
            if target.get("automation_id"):
                kwargs["auto_id"] = target["automation_id"]
            if target.get("control_type"):
                kwargs["control_type"] = target["control_type"]
            control = window.child_window(**kwargs) if kwargs else window
            if control.exists(timeout=target.get("timeout", 3)):
                return control.wrapper_object()
            # Modern Windows apps often expose controls as descendants instead of child_window matches.
            for candidate in window.wrapper_object().descendants():
                info = candidate.element_info
                if ((not target.get("name") or candidate.window_text() == target["name"])
                        and (not target.get("automation_id") or info.automation_id == target["automation_id"])
                        and (not target.get("control_type") or info.control_type == target["control_type"])
                        and candidate.is_visible()):
                    return candidate
            return None
        except Exception:
            return None

    def _ocr_click(self, target: dict[str, Any]) -> TargetEvidence:
        if not self.ocr_fallback or not target.get("text"):
            raise TargetNotFoundError(self._description(target))
        from perception import ScreenObserver
        import pyautogui

        match = ScreenObserver(target.get("minimum_confidence", 0.80)).find_text(target["text"])
        if match is None:
            raise TargetNotFoundError(self._description(target))
        pyautogui.click(match.center_x, match.center_y)
        return TargetEvidence("ocr", match.text, confidence=match.confidence, x=match.center_x, y=match.center_y)

    def _image_click(self, target: dict[str, Any]) -> TargetEvidence:
        from perception import Screen
        from perception.vision import TemplateMatcher
        import pyautogui

        frame = Screen().capture()
        match = TemplateMatcher().find(frame.image, target["image_path"], target.get("minimum_confidence", 0.85))
        if match is None:
            raise TargetNotFoundError(self._description(target))
        pyautogui.click(match.x, match.y)
        return TargetEvidence("image", Path(target["image_path"]).name, confidence=match.confidence, x=match.x, y=match.y)

    def _ocr_fill(self, target: dict[str, Any], value: str) -> TargetEvidence:
        evidence = self._ocr_click(target)
        import pyautogui
        pyautogui.write(value, interval=0.02)
        return evidence

    @staticmethod
    def _evidence(control, method: str) -> TargetEvidence:
        info = control.element_info
        return TargetEvidence(method, control.window_text(), getattr(info, "control_type", None))

    @staticmethod
    def _description(target: dict[str, Any]) -> str:
        return target.get("name") or target.get("text") or str(target)
