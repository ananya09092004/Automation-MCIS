from browser.intelligence import (
    DecisionEngine,
    WorldStateManager,
    ActionSelector
)

manager = WorldStateManager()

manager.update(

    page_type="login"

)

decision = DecisionEngine().decide(

    manager.get()

)

plan = ActionSelector().select(

    decision

)

for action in plan.actions:

    print(action)