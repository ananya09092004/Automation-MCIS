from browser.engines import BrowserEngine
from browser.skills import UploadSkill

engine = BrowserEngine()

engine.start()

page = engine.new_page()

page.goto(

    "https://the-internet.herokuapp.com/upload"

)

skill = UploadSkill(page)

print(

    skill.execute(

        "tests/sample.txt"

    )

)

engine.stop()