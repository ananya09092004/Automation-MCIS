import time

from desktop.keyboard import KeyboardController

keyboard = KeyboardController()

print("Open Notepad in 5 seconds...")

time.sleep(5)

keyboard.type_text("Hello from NEXUS!")

keyboard.enter()

keyboard.type_text("Desktop Automation Working")

keyboard.enter()

keyboard.hotkey("ctrl", "a")

keyboard.copy()

keyboard.enter()

keyboard.paste()