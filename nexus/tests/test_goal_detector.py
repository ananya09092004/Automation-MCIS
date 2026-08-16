from browser.intelligence import GoalDetector

detector = GoalDetector()

result = detector.detect(

    "Book Goa Trip",

    "login"

)

print(result)