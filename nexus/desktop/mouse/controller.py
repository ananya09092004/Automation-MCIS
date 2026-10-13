import pyautogui

from .interface import BaseMouse
from .models import MousePosition

class MouseController(BaseMouse):

    def move(
        self,
        x: int,
        y: int,
        duration: float = 0.3
    ):

        pyautogui.moveTo(
            x,
            y,
            duration=duration
        )

        return True

    def click(self):

        pyautogui.click()

        return True

    def right_click(self):

        pyautogui.rightClick()

        return True

    def double_click(self):

        pyautogui.doubleClick()

        return True

    def scroll_up(
        self,
        amount=500
    ):

        pyautogui.scroll(amount)

        return True

    def scroll_down(
        self,
        amount=500
    ):

        pyautogui.scroll(-amount)

        return True

    def drag_to(
        self,
        x,
        y,
        duration=0.5
    ):

        pyautogui.dragTo(
            x,
            y,
            duration=duration
        )

        return True

    def position(self):

        p = pyautogui.position()

        return MousePosition(

            x=p.x,

            y=p.y

        )