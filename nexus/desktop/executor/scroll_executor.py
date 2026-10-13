from desktop.mouse import MouseController
from perception import Screen
from perception.ocr import OCREngine
from perception.locator import Locator


class ScrollExecutor:

    def __init__(self):

        self.mouse = MouseController()

        self.screen = Screen()
        self.ocr = OCREngine()
        self.locator = Locator()

    def scroll_up(self, amount=500):

        self.mouse.scroll_up(amount)

        return True

    def scroll_down(self, amount=500):

        self.mouse.scroll_down(amount)

        return True

    def scroll_to_text(
        self,
        text,
        max_attempts=20,
        amount=600
    ):

        for _ in range(max_attempts):

            frame = self.screen.capture()

            items = self.ocr.read(frame.image)

            element = self.locator.find_first(
                items,
                text
            )

            if element is not None:

                self.mouse.move(
                    element.center_x,
                    element.center_y
                )

                return True

            self.mouse.scroll_down(amount)

        return False