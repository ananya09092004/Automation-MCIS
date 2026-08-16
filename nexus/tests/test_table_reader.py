from browser.engines import BrowserEngine

from browser.skills import TableReaderSkill

engine = BrowserEngine()

engine.start()

page = engine.new_page()

page.goto(
    "https://the-internet.herokuapp.com/tables"
)

skill = TableReaderSkill(page)

tables = skill.read()

print(
    len(tables)
)

print(
    tables[0][0]
)

engine.stop()