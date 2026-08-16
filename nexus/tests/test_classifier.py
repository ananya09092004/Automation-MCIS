from browser.intelligence import PageClassifier

classifier = PageClassifier()

page = """

Login

Username

Password

Sign In

"""

result = classifier.classify(

    page

)

print(result)