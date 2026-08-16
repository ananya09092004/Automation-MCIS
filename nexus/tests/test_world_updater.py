from browser.engines import BrowserEngine

from browser.intelligence import (
    WorldStateManager
)

from browser.intelligence.world_updater import (
    WorldUpdater
)

engine = BrowserEngine()

engine.start()

page = engine.new_page()

page.goto(
    "https://github.com/login"
)

world = WorldStateManager()

updater = WorldUpdater(
    page,
    world
)

state = updater.update()

print(state.page_type)
print(state.current_url)
print(state.page_title)
print(state.observations)

engine.stop()