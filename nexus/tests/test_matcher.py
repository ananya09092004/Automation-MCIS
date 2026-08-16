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