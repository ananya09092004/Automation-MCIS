from browser.engines import BrowserEngine
from browser.inspection import WebsiteInspector

browser = BrowserEngine()

browser.start()          # <-- Ye missing tha

page = browser.new_page()

page.goto("https://google.com")

inspector = WebsiteInspector(page)

analysis = inspector.analyze()

print(analysis)

browser.stop()