from browser.engines import BrowserEngine
from browser.intelligence import ElementAnalyzer

browser = BrowserEngine()

browser.start()

page = browser.new_page()

page.goto("https://google.com")

analyzer = ElementAnalyzer(page)

print("Buttons")
for i in analyzer.analyze_buttons():
    print(i)

print()

print("Links")
for i in analyzer.analyze_links()[:5]:
    print(i)

print()

print("Forms")

print(analyzer.analyze_forms())

browser.stop()