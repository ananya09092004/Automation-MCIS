from desktop.automation.planner import DesktopTaskPlanner

planner = DesktopTaskPlanner()

tests = [

    "Open Notepad",

    "Open Chrome",

    "Open VSCode",

    "Open Calculator",

    "Open Notepad and type Hello Nexus",

    "Open Chrome and write OpenAI"

]

for t in tests:

    print("\nCOMMAND :", t)

    actions = planner.plan(t)

    for a in actions:

        print(a)