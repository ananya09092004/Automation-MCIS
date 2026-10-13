from perception import Screen
from perception.ocr import OCREngine
from perception.locator import Locator


class ActionVerifier:

    def __init__(self):

        self.screen = Screen()
        self.ocr = OCREngine()
        self.locator = Locator()

    def text_exists(self, text):

        frame = self.screen.capture()

        items = self.ocr.read(frame.image)

        element = self.locator.find_first(
            items,
            text
        )

        return element is not None

    def wait_for_text(
        self,
        text,
        timeout=15,
        interval=0.5
    ):

        import time

        start = time.time()

        while time.time() - start < timeout:

            if self.text_exists(text):
                return True

            time.sleep(interval)

        return False