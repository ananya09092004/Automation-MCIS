from browser.controller import BrowserController
from browser.elements import ElementFinder

browser = BrowserController()

browser.start()

browser.open(

    "https://www.google.com"

)

finder = ElementFinder(

    browser.page

)

search = finder.by_role(

    "combobox"

)

print(

    search.is_visible()

)

browser.stop()