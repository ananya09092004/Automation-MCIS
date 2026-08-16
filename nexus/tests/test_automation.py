from desktop.automation import AutomationEngine
from desktop.automation.models import Action

engine = AutomationEngine()

actions = [

    Action(

        action="type_text",

        text="Hello Nexus"

    )

]

print(

    engine.run(actions)

)