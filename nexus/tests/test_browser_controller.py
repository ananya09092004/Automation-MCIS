from browser.controller import BrowserController

browser = BrowserController()

browser.start()

browser.open(

    "https://www.google.com"

)

print(

    browser.title()

)

print(

    browser.current_url()

)

browser.stop()