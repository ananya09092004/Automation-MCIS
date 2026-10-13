"""Live smoke test for KeyboardController: types and edits into whatever
window currently has OS keyboard focus, via pyautogui (type_text, enter,
select-all/hotkey, copy, paste).

SAFETY: this test does not launch or target a specific application/window
-- it types into whatever currently has focus. Only run it explicitly
(pytest -m live), and only with an app/text field already focused that is
safe to type into. It must never run as a side effect of plain pytest
collection (e.g. `pytest -m "not live" -q`) -- that was the actual bug
this file used to have: all of the calls below previously ran at module
import time, with no test function and no marker, so simply collecting
this file executed real keystrokes.
"""

import time

import pytest

from desktop.keyboard import KeyboardController


@pytest.mark.live
def test_keyboard_controller_types_and_edits_into_focused_window():
    keyboard = KeyboardController()

    print("Open Notepad in 5 seconds...")

    time.sleep(5)

    assert keyboard.type_text("Hello from NEXUS!") is True
    assert keyboard.enter() is True
    assert keyboard.type_text("Desktop Automation Working") is True
    assert keyboard.enter() is True
    assert keyboard.hotkey("ctrl", "a") is True
    assert keyboard.copy() is True
    assert keyboard.enter() is True
    assert keyboard.paste() is True