from browser.engines import BrowserEngine

from browser.skills import NavigationSkill

engine = BrowserEngine()

engine.start()

page = engine.new_page()

nav = NavigationSkill(page)

nav.goto(

    "https://google.com"

)

print(

    nav.title()

)

nav.goto(

    "https://github.com"

)

print(

    nav.title()

)

nav.back()

nav.wait()

print(

    nav.title()

)

nav.forward()

nav.wait()

print(

    nav.title()

)

engine.stop()