from browser.engines import BrowserEngine
from browser.intelligence import ElementAnalyzer

browser = BrowserEngine()

browser.start()

page = browser.new_page()

page.goto("https://www.wikipedia.org")

analyzer = ElementAnalyzer(page)

print()

print(analyzer.analyze_navigation())

print()

print(analyzer.analyze_page_semantics())

browser.stop()