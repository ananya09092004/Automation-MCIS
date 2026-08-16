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