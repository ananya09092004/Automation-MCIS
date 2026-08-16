"""Execute desktop actions against accessible UI elements, with OCR fallback."""

from typing import Any

from desktop.accessibility import WindowsUIAutomation
from desktop.keyboard.controller import KeyboardController
from desktop.mouse.controller import MouseController
from perception import ScreenObserver


class DesktopTargetExecutor:
    def __init__(self, accessibility=None, observer=None, mouse=None, keyboard=None):
        self.accessibility = accessibility or WindowsUIAutomation()
        self.observer = observer or ScreenObserver()
        self.mouse = mouse or MouseController()
        self.keyboard = keyboard or KeyboardController()

    def click(self, target: dict[str, Any]) -> dict[str, Any]:
        element = self.accessibility.find(target)
        if element and self.accessibility.click(element):
            return {"success": True, "method": "uia", "text": self.accessibility.read_text(element)}
        visual = self._find_visual(target)
        if visual:
            self.mouse.move(visual.center_x, visual.center_y)
            self.mouse.click()
            return {"success": True, "method": "ocr", "text": visual.text, "confidence": visual.confidence}
        return {"success": False, "method": "none"}

    def fill(self, target: dict[str, Any], value: str) -> dict[str, Any]:
        element = self.accessibility.find(target)
        if element and self.accessibility.fill(element, value):
            return {"success": True, "method": "uia", "text": self.accessibility.read_text(element)}
        visual = self._find_visual(target)
        if visual:
            self.mouse.move(visual.center_x, visual.center_y)
            self.mouse.click()
            self.keyboard.hotkey("ctrl", "a")
            self.keyboard.type_text(value)
            return {"success": True, "method": "ocr", "text": visual.text, "confidence": visual.confidence}
        return {"success": False, "method": "none"}

    def read(self, target: dict[str, Any]) -> dict[str, Any]:
        element = self.accessibility.find(target)
        if element:
            text = self.accessibility.read_text(element)
            return {"success": bool(text), "method": "uia", "text": text}
        visual = self._find_visual(target)
        if visual:
            return {"success": True, "method": "ocr", "text": visual.text, "confidence": visual.confidence}
        return {"success": False, "method": "none"}

    def _find_visual(self, target: dict[str, Any]):
        text = target.get("text") or target.get("title") or target.get("label")
        return self.observer.find_text(text) if text else None
