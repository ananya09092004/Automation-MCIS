from browser.engines import BrowserEngine

from browser.skills import SearchSkill

engine = BrowserEngine()

engine.start()

page = engine.new_page()

page.goto("https://www.wikipedia.org/")

skill = SearchSkill(page)

print(

    skill.execute(

        "Playwright Python"

    )

)

engine.stop()