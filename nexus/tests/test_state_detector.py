import time

from desktop.intelligence.state_detector import StateDetector

detector = StateDetector()

print("Change screen in 10 seconds...")

print(

    detector.wait_until_changed()

)