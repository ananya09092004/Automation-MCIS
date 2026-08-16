from browser.engines import BrowserEngine

from browser.skills import FormFillSkill

engine = BrowserEngine()

engine.start()

page = engine.new_page()

page.goto(

    "https://github.com/signup"

)

skill = FormFillSkill(page)

print(

    skill.execute(

        {

            "email":"demo@test.com",

            "password":"12345678",

            "username":"demouser"

        }

    )

)

engine.stop()