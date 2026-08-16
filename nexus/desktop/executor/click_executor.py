from perception import Screen
from perception.ocr import OCREngine
from perception.locator import Locator
from desktop.mouse import MouseController


class ClickExecutor:

    def __init__(self):

        self.screen = Screen()
        self.ocr = OCREngine()
        self.locator = Locator()
        self.mouse = MouseController()

    def click_text(self, text):

        frame = self.screen.capture()

        items = self.ocr.read(frame.image)

        element = self.locator.find_first(items, text)

        if element is None:

            return False

        self.mouse.move(

            element.center_x,

            element.center_y

        )

        self.mouse.click()

        return True