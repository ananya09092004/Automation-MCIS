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
def test_browser_session_live_scratch():
    from browser.controller import BrowserController
    from browser.session import BrowserSession

    browser = BrowserController()

    browser.start()

    session = BrowserSession(

        browser.engine.browser,

        browser.engine.context

    )

    page1 = session.new_tab()

    page1.goto("https://google.com")

    page2 = session.new_tab()

    page2.goto("https://openai.com")

    print(

        session.count()

    )

    print(

        session.current_title()

    )

    session.switch(

        0

    )

    print(

        session.current_url()

    )

    browser.stop()
