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
def test_autonomous_executor_live_scratch():
    from browser.engines import BrowserEngine

    from browser.execution import AutonomousExecutor

    from browser.intelligence.world_state import WorldState

    engine = BrowserEngine()

    engine.start()

    page = engine.new_page()

    page.goto(
        "https://the-internet.herokuapp.com/login"
    )

    state = WorldState(

        user_goal="Login",

        page_type="login",

        current_stage="login",

        next_stage="authenticate"

    )

    executor = AutonomousExecutor(page)

    print(

        executor.run(

            state,

            context={

                "username": "tomsmith",

                "password": "SuperSecretPassword!"

            }

        )

    )
    engine.stop()
