import time

from desktop.workflow import WorkflowEngine

workflow = WorkflowEngine()

steps = [

    {
        "action": "open_app",
        "name": "notepad"
    },

    {
        "action": "type",
        "text": "Workflow Started",
        "delay": 1
    },

    {
        "action": "press_enter"
    },

    {
        "action": "type",
        "text": "Nexus Desktop Automation"
    }

]

time.sleep(2)

print(

    workflow.run(steps)

)