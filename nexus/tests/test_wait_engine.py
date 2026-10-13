"""Live scratch script -- converted from unmarked top-level code that
ran automatically at mere module import/collection time (so simply
running `pytest -m "not live" -q`, or even `--collect-only`, executed
real actions/side effects with no explicit opt-in) into a proper
@pytest.mark.live-marked test function.

Same test-isolation gap already fixed for test_terminal.py/
test_keyboard.py/test_input_executor.py (P2.16 audit) -- this file has
no assertions and isn't a real regression test, it's a developer
scratch script that happens to be named test_*.py, so it must never
run as a side effect of ordinary (non-live) test collection.
"""
import pytest


@pytest.mark.live
def test_wait_engine_live_scratch():
    import time

    from desktop.app_controller.controller import AppController
    from desktop.intelligence.wait_engine import WaitEngine

    app = AppController()

    wait = WaitEngine()

    app.open_app("notepad")

    print(

        wait.wait_for_window("Notepad")

    )

    wait.focus("Notepad")

    time.sleep(2)
