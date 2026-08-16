from desktop.keyboard import KeyboardController


class InputExecutor:

    def __init__(self):

        self.keyboard = KeyboardController()

    def type(self, text):

        self.keyboard.type_text(text)

        return True

    def enter(self):

        self.keyboard.press("enter")

        return True

    def escape(self):

        self.keyboard.press("esc")

        return True

    def tab(self):

        self.keyboard.press("tab")

        return True

    def backspace(self):

        self.keyboard.press("backspace")

        return True

    def delete(self):

        self.keyboard.press("delete")

        return True

    def copy(self):

        self.keyboard.hotkey("ctrl", "c")

        return True

    def paste(self):

        self.keyboard.hotkey("ctrl", "v")

        return True

    def cut(self):

        self.keyboard.hotkey("ctrl", "x")

        return True

    def undo(self):

        self.keyboard.hotkey("ctrl", "z")

        return True

    def redo(self):

        self.keyboard.hotkey("ctrl", "y")

        return True

    def save(self):

        self.keyboard.hotkey("ctrl", "s")

        return True

    def select_all(self):

        self.keyboard.hotkey("ctrl", "a")

        return True

    def shortcut(self, *keys):

        self.keyboard.hotkey(*keys)

        return True