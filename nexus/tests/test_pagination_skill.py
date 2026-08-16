from browser.engines import BrowserEngine

from browser.skills import PaginationSkill

engine = BrowserEngine()

engine.start()

page = engine.new_page()

page.goto(

    "https://books.toscrape.com"

)

skill = PaginationSkill(page)

print(

    skill.next_page()

)

engine.stop()