from browser.engines import BrowserEngine

engine = BrowserEngine()

engine.start()

print(

    engine.is_running()

)

page = engine.new_page()

page.goto(

    "https://example.com"

)

print(

    page.title()

)

engine.stop()

print(

    engine.is_running()

)