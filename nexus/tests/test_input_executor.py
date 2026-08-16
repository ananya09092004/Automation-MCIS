import time

from desktop.executor.input_executor import InputExecutor

input_executor = InputExecutor()

time.sleep(5)

input_executor.type("Hello Nexus")

input_executor.enter()

input_executor.type("Desktop Automation Working")

input_executor.select_all()

input_executor.copy()

input_executor.paste()