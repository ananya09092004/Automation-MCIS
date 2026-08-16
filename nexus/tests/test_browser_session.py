from browser.controller import BrowserController
from browser.session import BrowserSession

browser = BrowserController()

browser.start()

session = BrowserSession(

    browser.engine.browser,

    browser.engine.context

)

page1 = session.new_tab()

page1.goto("https://google.com")

page2 = session.new_tab()

page2.goto("https://openai.com")

print(

    session.count()

)

print(

    session.current_title()

)

session.switch(

    0

)

print(

    session.current_url()

)

browser.stop()