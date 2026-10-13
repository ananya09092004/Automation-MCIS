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
def test_runtime_live_scratch():
    from browser.engines import BrowserEngine

    from browser.runtime import ExecutionRuntime

    from browser.intelligence import (

        WorldStateManager,

        DecisionEngine,

        ActionSelector,

        ExecutionPlanner

    )

    engine = BrowserEngine()

    engine.start()

    page = engine.new_page()

    page.goto("https://github.com/login")

    manager = WorldStateManager()

    manager.update(

        page_type="login"

    )

    decision = DecisionEngine().decide(

        manager.get()

    )

    actions = ActionSelector().select(

        decision

    )

    plan = ExecutionPlanner().build(

        actions.actions

    )

    runtime = ExecutionRuntime(

        page

    )

    print(

        runtime.execute(

            plan,

            {

                "username": "demo@example.com",

                "password": "123456"

            }

        )

    )

    engine.stop()
