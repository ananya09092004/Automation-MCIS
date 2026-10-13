"""Read-only screen observation for desktop execution and verification."""

from perception.ocr import OCREngine
from perception.screen import Screen
from perception.ui_detector.matcher import UIMatcher
from perception.ui_detector.models import UIElement


class ScreenObserver:
    def __init__(self, minimum_confidence: float = 0.65):
        self.minimum_confidence = minimum_confidence
        self.screen = Screen()
        self.ocr = OCREngine()
        self.matcher = UIMatcher()

    def observe(self) -> list[UIElement]:
        frame = self.screen.capture()
        elements = [
            UIElement(item.text, item.confidence, item.x1, item.y1, item.x2, item.y2)
            for item in self.ocr.read(frame.image)
            if item.confidence >= self.minimum_confidence
        ]
        return self.matcher.classify_all(elements)

    def find_text(self, text: str) -> UIElement | None:
        expected = text.strip().casefold()
        matches = [item for item in self.observe() if expected in item.text.strip().casefold()]
        return max(matches, key=lambda item: item.confidence, default=None)
