from desktop.automation.rollback import RollbackEngine

from desktop.automation.models import Action

import os


path = "rollback_test.txt"

with open(

    path,

    "w"

):

    pass


engine = RollbackEngine()

action = Action(

    action="create_file",

    path=path

)

print(

    engine.rollback(

        action

    )

)

print(

    os.path.exists(path)

)