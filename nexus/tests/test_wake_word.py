from voice.wake_word import WakeWordDetector

detector = WakeWordDetector()

while True:

    if detector.listen():

        print("Wake word detected!")
        break