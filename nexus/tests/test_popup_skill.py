from browser.engines import BrowserEngine

from browser.skills import PopupSkill

engine = BrowserEngine()

engine.start()

page = engine.new_page()

page.goto(
    "https://the-internet.herokuapp.com/entry_ad"
)

page.wait_for_timeout(5000)

skill = PopupSkill(page)

print(

    skill.close()

)

engine.stop()