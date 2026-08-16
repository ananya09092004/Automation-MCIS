from desktop.registry import AppRegistry

registry = AppRegistry()

for name in [

    "chrome",

    "browser",

    "google chrome",

    "code",

    "calculator",

    "notepad"

]:

    app = registry.find(name)

    print(name)

    print(app)

    print()