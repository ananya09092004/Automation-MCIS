from browser.engines import BrowserEngine
from browser.intelligence import ElementAnalyzer

browser = BrowserEngine()

browser.start()

page = browser.new_page()

page.goto("https://google.com")

analyzer = ElementAnalyzer(page)

print(analyzer)

browser.stop()