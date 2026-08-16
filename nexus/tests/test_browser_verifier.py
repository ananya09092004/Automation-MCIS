from browser.controller import BrowserController
from browser.verifier import BrowserVerifier

browser = BrowserController()

browser.start()

browser.open(

    "https://www.google.com"

)

verify = BrowserVerifier(

    browser.page

)

print(

    verify.url_contains(

        "google"

    )

)

print(

    verify.title_contains(

        "Google"

    )

)

browser.stop()