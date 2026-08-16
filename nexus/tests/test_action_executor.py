from browser.engines import BrowserEngine

from browser.execution import ActionExecutor

from browser.intelligence.action_selector import BrowserAction


engine = BrowserEngine()

engine.start()

page = engine.new_page()

page.goto(

    "https://github.com/login"

)

executor = ActionExecutor(page)

action = BrowserAction(

    action="focus",

    target="#login_field"

)

print(

    executor.execute(action)

)

engine.stop()