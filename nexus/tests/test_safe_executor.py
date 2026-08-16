from browser.engines import BrowserEngine

from browser.interaction import SafeExecutor

from browser.actions import BrowserActions

engine = BrowserEngine()

engine.start()

page = engine.new_page()

page.goto(

    "https://google.com"

)

locator = page.locator(

    'textarea[name="q"]'

)

executor = SafeExecutor(page)

actions = BrowserActions()

executor.execute(

    locator,

    actions.fill,

    "OpenAI"

)

executor.execute(

    locator,

    actions.press,

    "Enter"

)

print(

    "Success"

)

engine.stop()