from browser.intelligence import (

    WorldStateManager,

    GoalProgressEvaluator

)

manager = WorldStateManager()

manager.update(

    page_type="login"

)

state = manager.get()

updated = GoalProgressEvaluator().evaluate(

    state

)

print(updated.current_stage)

print(updated.next_stage)

print(updated.completed)