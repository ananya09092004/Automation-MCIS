import pyperclip


class ClipboardController:

    def copy(
        self,
        text: str
    ) -> bool:

        pyperclip.copy(text)

        return True

    def paste(self):

        return pyperclip.paste()

    def get(self):
        """Read the current clipboard text without changing it."""
        return pyperclip.paste()

    def clear(self):

        pyperclip.copy("")

        return True

    def has_text(self):

        return bool(
            pyperclip.paste()
        )

    def cut(self) -> bool:
        """Cut the currently selected UI content into the clipboard."""
        import pyautogui
        pyautogui.hotkey("ctrl", "x")
        return True
