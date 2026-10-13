from perception import Screen
from perception.ocr import OCREngine
from perception.ui_detector.models import UIElement
from perception.ui_detector.matcher import UIMatcher


class UIDetector:

    def __init__(self):

        self.screen = Screen()
        self.ocr = OCREngine()
        self.matcher = UIMatcher()

    def detect(self):

        frame = self.screen.capture()

        items = self.ocr.read(frame.image)

        elements = []

        for item in items:

            elements.append(

                UIElement(

                    text=item.text,
                    confidence=item.confidence,
                    x1=item.x1,
                    y1=item.y1,
                    x2=item.x2,
                    y2=item.y2

                )

            )

        return self.matcher.classify_all(elements)