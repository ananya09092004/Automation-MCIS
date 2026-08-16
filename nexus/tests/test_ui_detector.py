from perception.ui_detector.detector import UIDetector

detector = UIDetector()

elements = detector.detect()

for e in elements:

    print(e)