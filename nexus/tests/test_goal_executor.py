from browser.engines import BrowserEngine

from browser.runtime import ExecutionRuntime

from browser.intelligence import (

    WorldStateManager,

    DecisionEngine,

    ActionSelector,

    ExecutionPlanner,

    GoalExecutor

)

engine = BrowserEngine()

engine.start()

page = engine.new_page()

page.goto(

    "https://github.com/login"

)

runtime = ExecutionRuntime(page)

world = WorldStateManager()

world.update(

    page_type="login"

)

executor = GoalExecutor(

    DecisionEngine(),

    ActionSelector(),

    ExecutionPlanner(),

    runtime,

    world

)

print(

    executor.execute(

        {

            "username":"demo@test.com",

            "password":"123456"

        }

    )

)

engine.stop()