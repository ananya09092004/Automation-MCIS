from browser.engines import BrowserEngine

from browser.intelligence import ElementAnalyzer

browser = BrowserEngine()

browser.start()

page = browser.new_page()

page.goto("https://www.wikipedia.org")

analyzer = ElementAnalyzer(page)

print()

print("TABLES")

print(analyzer.analyze_tables())

print()

print("UPLOADS")

print(analyzer.analyze_uploads())

print()

print("DIALOGS")

print(analyzer.analyze_dialogs())

browser.stop()