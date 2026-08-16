from desktop.automation.recovery import RecoveryEngine

from desktop.automation.models import Action

engine = RecoveryEngine()

action = Action(

    action="type_text",

    text="Hello",

    title="Visual Studio Code"

)

print(

    engine.recover(action)

)