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
def test_execution_pipeline_live_scratch():
    from browser.engines import BrowserEngine
    from browser.execution.action_executor import ActionExecutor
    from browser.intelligence.action_model import Action


    engine = BrowserEngine()
    engine.start()

    page = engine.new_page()

    page.goto(
        "https://the-internet.herokuapp.com/login",
        wait_until="networkidle"
    )

    executor = ActionExecutor(page)

    print("\n========== GENERIC ACTION TEST ==========")


    actions = [
        Action(
            action="fill",
            target="username",
            value="tomsmith"
        ),

        Action(
            action="fill",
            target="password",
            value="SuperSecretPassword!"
        ),

        Action(
            action="click",
            target="login_button"
        )
    ]


    results = []

    for action in actions:

        result = executor.execute(action)

        results.append(result)

        print(
            "RESULT :",
            result
        )

        if not result:
            print(
                "\nACTION FAILED ->",
                action.action,
                action.target
            )
            break


    page.wait_for_timeout(1000)

    print("\n========== FINAL ==========")

    print("URL :", page.url)

    print(
        "SECURE AREA :",
        page.get_by_text(
            "Secure Area",
            exact=False
        ).count()
    )

    print("\nRESULTS")

    for result in results:
        print(result)

    engine.stop()
