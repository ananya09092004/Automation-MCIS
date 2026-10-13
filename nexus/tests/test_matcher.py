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
def test_matcher_live_scratch():
    from browser.engines import BrowserEngine
    from browser.intelligence import ElementMatcher

    engine = BrowserEngine()

    engine.start()

    page = engine.new_page()

    page.goto(

        "https://github.com/login"

    )

    matcher = ElementMatcher(page)

    print(

        matcher.match(

            "username"

        ) is not None

    )

    print(

        matcher.match(

            "password"

        ) is not None

    )

    print(

        matcher.match(

            "login_button"

        ) is not None

    )

    engine.stop()
