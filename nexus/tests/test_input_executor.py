"""Live smoke test for InputExecutor: exercises real keyboard automation
via pyautogui (type, enter, select-all, copy, paste).

SAFETY: this test types into whatever window currently has OS keyboard
focus -- unlike test_live_notepad_ui_automation.py, it does not launch or
target a specific application/window. Only run it explicitly (pytest -m
live), and only with an app/text field already focused that is safe to
type into. It must never run as a side effect of plain pytest collection
(e.g. `pytest -m "not live" -q`) -- that was the actual bug this file
used to have: all of the calls below previously ran at module import
time, with no test function and no marker, so simply collecting this
file executed real keystrokes.
"""

import time

import pytest

from desktop.executor.input_executor import InputExecutor


@pytest.mark.live
def test_input_executor_types_and_edits_into_focused_window():
    input_executor = InputExecutor()
    time.sleep(5)
    assert input_executor.type("Hello Nexus") is True
    assert input_executor.enter() is True
    assert input_executor.type("Desktop Automation Working") is True
    assert input_executor.select_all() is True
    assert input_executor.copy() is True
    assert input_executor.paste() is True
