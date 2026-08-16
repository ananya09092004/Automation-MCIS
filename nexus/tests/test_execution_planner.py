from browser.intelligence import (
    WorldStateManager,
    DecisionEngine,
    ActionSelector,
    ExecutionPlanner
)

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

for step in plan.steps:
    print(step)