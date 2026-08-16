import time

import pyautogui

from .models import ScreenFrame


class ScreenCapture:

    def capture(self) -> ScreenFrame:

        image = pyautogui.screenshot()

        width, height = image.size

        return ScreenFrame(

            image=image,

            width=width,

            height=height,

            timestamp=time.time()

        )

    def save(

        self,

        path: str

    ) -> bool:

        frame = self.capture()

        frame.image.save(path)

        return True