from browser.engines import BrowserEngine
from browser.intelligence import (
    ElementMatcher,
    SemanticScorer
)

engine = BrowserEngine()

engine.start()

page = engine.new_page()

page.goto("https://github.com/login")

matcher = ElementMatcher(page)

locator = matcher.match("username")

score = SemanticScorer().score(
    locator,
    "username"
)

print(score > 0)

engine.stop()