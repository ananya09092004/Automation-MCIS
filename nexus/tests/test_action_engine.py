import time

from desktop.executor.action_engine import ActionEngine

engine = ActionEngine()

engine.execute(
    {
        "action": "open_app",
        "name": "notepad"
    }
)

time.sleep(2)

engine.execute(
    {
        "action": "type",
        "text": "Hello from Nexus"
    }
)

engine.execute(
    {
        "action": "press_enter"
    }
)

engine.execute(
    {
        "action": "type",
        "text": "Desktop Automation Engine Working"
    }
)