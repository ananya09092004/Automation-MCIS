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
def test_page_understanding_live_scratch():
    from browser.engines import BrowserEngine
    from browser.intelligence import ElementAnalyzer

    browser = BrowserEngine()

    browser.start()

    page = browser.new_page()

    page.goto("https://www.wikipedia.org")

    analyzer = ElementAnalyzer(page)

    print()

    print(analyzer.analyze_navigation())

    print()

    print(analyzer.analyze_page_semantics())

    browser.stop()
