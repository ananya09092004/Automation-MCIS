from browser.controller import BrowserController
from browser.elements import ElementFinder
from browser.actions import BrowserActions

browser = BrowserController()

browser.start()

browser.open(

    "https://www.google.com"

)

finder = ElementFinder(

    browser.page

)

actions = BrowserActions()

search = finder.by_role(

    "combobox"

)

actions.fill(

    search,

    "Playwright"

)

actions.press(

    search,

    "Enter"

)

print(

    browser.page.title()

)

browser.stop()