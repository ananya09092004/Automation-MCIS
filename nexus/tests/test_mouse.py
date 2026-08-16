from desktop.mouse import MouseController
import time

mouse = MouseController()

print(mouse.position())

time.sleep(3)

mouse.move(500,500)

mouse.click()

time.sleep(1)

mouse.right_click()

time.sleep(1)

mouse.double_click()