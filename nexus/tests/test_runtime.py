from browser.engines import BrowserEngine

from browser.runtime import ExecutionRuntime

from browser.intelligence import (

    WorldStateManager,

    DecisionEngine,

    ActionSelector,

    ExecutionPlanner

)

engine = BrowserEngine()

engine.start()

page = engine.new_page()

page.goto("https://github.com/login")

manager = WorldStateManager()

manager.update(

    page_type="login"

)

decision = DecisionEngine().decide(

    manager.get()

)

actions = ActionSelector().select(

    decision

)

plan = ExecutionPlanner().build(

    actions.actions

)

runtime = ExecutionRuntime(

    page

)

print(

    runtime.execute(

        plan,

        {

            "username": "demo@example.com",

            "password": "123456"

        }

    )

)

engine.stop()