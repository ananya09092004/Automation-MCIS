from perception import Screen
from perception.ocr import OCREngine
from perception.locator import Locator
from desktop.mouse import MouseController
from desktop.keyboard import KeyboardController


class UIExecutor:

    def __init__(self):

        self.screen = Screen()
        self.ocr = OCREngine()
        self.locator = Locator()

        self.mouse = MouseController()
        self.keyboard = KeyboardController()

    def click(self, text):

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

    def double_click(self, text):

        frame = self.screen.capture()

        items = self.ocr.read(frame.image)

        element = self.locator.find_first(items, text)

        if element is None:
            return False

        self.mouse.move(
            element.center_x,
            element.center_y
        )

        self.mouse.double_click()

        return True

    def right_click(self, text):

        frame = self.screen.capture()

        items = self.ocr.read(frame.image)

        element = self.locator.find_first(items, text)

        if element is None:
            return False

        self.mouse.move(
            element.center_x,
            element.center_y
        )

        self.mouse.right_click()

        return True

    def type(self, value):

        self.keyboard.write(value)

        return True