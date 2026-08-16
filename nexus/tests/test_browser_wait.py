from browser.controller import BrowserController
from browser.wait import BrowserWait

browser = BrowserController()

browser.start()

browser.open(

    "https://www.google.com"

)

wait = BrowserWait(

    browser.page

)

print(

    wait.page_loaded()

)

print(

    wait.network_idle()

)

browser.stop()