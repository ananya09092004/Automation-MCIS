from perception import Screen
from perception.ocr import OCREngine
from perception.locator import Locator


screen = Screen()

frame = screen.capture()

ocr = OCREngine()

items = ocr.read(frame.image)

locator = Locator()


element = locator.find_first(

    items,

    "Update"

)


print(element)