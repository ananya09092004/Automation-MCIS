from desktop.automation.workflow import WorkflowPlanner

planner = WorkflowPlanner()

actions = planner.plan(

    "Open Notepad and type Hello Nexus"

)

for a in actions:

    print(a)