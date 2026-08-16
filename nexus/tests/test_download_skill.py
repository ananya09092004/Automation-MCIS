from browser.engines import BrowserEngine

from browser.skills import DownloadSkill

engine = BrowserEngine()

engine.start()

page = engine.new_page()

page.goto(
    "https://the-internet.herokuapp.com/download"
)

locator = page.locator("#content a").first

skill = DownloadSkill(page)

print(
    skill.execute(locator)
)
engine.stop()