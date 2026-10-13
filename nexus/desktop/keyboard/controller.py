import pyautogui
import time


class KeyboardController:

    def type_text(
        self,
        text: str,
        interval: float = 0.02
    ) -> bool:

        pyautogui.write(
            text,
            interval=interval
        )

        return True

    def press(
        self,
        key: str
    ) -> bool:

        pyautogui.press(key)

        return True

    def hotkey(
        self,
        *keys
    ) -> bool:

        pyautogui.hotkey(*keys)

        return True

    def key_down(
        self,
        key: str
    ) -> bool:

        pyautogui.keyDown(key)

        return True

    def key_up(
        self,
        key: str
    ) -> bool:

        pyautogui.keyUp(key)

        return True

    def enter(self):

        return self.press("enter")

    def tab(self):

        return self.press("tab")

    def escape(self):

        return self.press("esc")

    def backspace(self):

        return self.press("backspace")

    def delete(self):

        return self.press("delete")

    def select_all(self):

        return self.hotkey("ctrl", "a")

    def copy(self):

        return self.hotkey("ctrl", "c")

    def paste(self):

        return self.hotkey("ctrl", "v")

    def cut(self):

        return self.hotkey("ctrl", "x")

    def undo(self):

        return self.hotkey("ctrl", "z")

    def redo(self):

        return self.hotkey("ctrl", "y")

    def save(self):

        return self.hotkey("ctrl", "s")