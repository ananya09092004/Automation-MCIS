from browser.engines import BrowserEngine

from browser.skills import InfiniteScrollSkill

engine = BrowserEngine()

engine.start()

page = engine.new_page()

page.goto(

    "https://infinite-scroll.com/demo/full-page/"

)

skill = InfiniteScrollSkill(page)

print(

    skill.scroll()

)

engine.stop()