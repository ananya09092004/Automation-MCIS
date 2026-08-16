from copy import deepcopy

from browser.intelligence import (

    WorldStateManager,

    DynamicReplanner

)

manager = WorldStateManager()

manager.update(

    page_type="login",

    current_url="https://github.com/login"

)

previous = deepcopy(

    manager.get()

)

manager.update(

    page_type="login",

    current_url="https://github.com/login"

)

current = manager.get()

result = DynamicReplanner().evaluate(

    previous,

    current,

    execution_success=True

)

print(result.should_replan)

print(result.reason)