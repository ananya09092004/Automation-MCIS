from perception import Screen
from perception.ocr import OCREngine
from perception.ui_detector.models import UIElement
from perception.ui_detector.matcher import UIMatcher


screen = Screen()

ocr = OCREngine()

matcher = UIMatcher()

frame = screen.capture()

items = ocr.read(frame.image)

ui = []

for item in items:

    ui.append(

        UIElement(

            text=item.text,
            confidence=item.confidence,
            x1=item.x1,
            y1=item.y1,
            x2=item.x2,
            y2=item.y2

        )

    )

result = matcher.classify_all(ui)

for r in result:

    if r.clickable or r.editable:

        print(r)