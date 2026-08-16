from desktop.automation.verifier import ActionVerifier

from desktop.automation.models import Action

verifier = ActionVerifier()

action = Action(

    action="open_app",

    app="chrome"

)

print(

    verifier.verify(action)

)