import time

from desktop.app_controller.controller import AppController
from desktop.intelligence.wait_engine import WaitEngine

app = AppController()

wait = WaitEngine()

app.open_app("notepad")

print(

    wait.wait_for_window("Notepad")

)

wait.focus("Notepad")

time.sleep(2)