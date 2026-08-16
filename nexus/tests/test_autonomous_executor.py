from browser.engines import BrowserEngine

from browser.execution import AutonomousExecutor

from browser.intelligence.world_state import WorldState

engine = BrowserEngine()

engine.start()

page = engine.new_page()

page.goto(
    "https://the-internet.herokuapp.com/login"
)

state = WorldState(

    user_goal="Login",

    page_type="login",

    current_stage="login",

    next_stage="authenticate"

)

executor = AutonomousExecutor(page)

print(

    executor.run(

        state,

        context={

            "username": "tomsmith",

            "password": "SuperSecretPassword!"

        }

    )

)
engine.stop()