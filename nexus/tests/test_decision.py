from browser.intelligence import WorldStateManager
from browser.intelligence import DecisionEngine

manager = WorldStateManager()

manager.update(

    user_goal="Book Kerala Trip",

    page_type="login"

)

engine = DecisionEngine()

print(

    engine.decide(

        manager.get()

    )

)