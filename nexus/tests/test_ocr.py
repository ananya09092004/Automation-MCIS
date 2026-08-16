from perception import Screen
from perception.ocr import OCREngine

screen = Screen()

frame = screen.capture()

ocr = OCREngine()

items = ocr.read(frame.image)

print()

for item in items:

    print(item)