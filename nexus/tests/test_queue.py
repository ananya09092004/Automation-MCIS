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
def test_queue_live_scratch():
    from desktop.automation.queue import ActionQueue

    from desktop.automation.models import Action


    queue = ActionQueue()

    queue.add(

        Action(

            action="open_app",

            app="chrome"

        )

    )

    queue.add(

        Action(

            action="type_text",

            text="Hello"

        )

    )

    print(queue.size())

    print(queue.peek())

    print(queue.get())

    print(queue.size())

    print(queue.empty())

    queue.clear()

    print(queue.empty())
