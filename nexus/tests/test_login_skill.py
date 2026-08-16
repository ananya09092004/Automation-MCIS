from browser.engines import BrowserEngine
from browser.skills import LoginSkill

engine = BrowserEngine()

engine.start()

page = engine.new_page()

page.goto(
    "https://github.com/login"
)

skill = LoginSkill(page)

print(

    skill.execute(

        "demo@test.com",

        "123456"

    )

)

engine.stop()