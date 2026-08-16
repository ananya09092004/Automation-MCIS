from desktop.automation.history import HistoryManager

history = HistoryManager()

history.add(

    "Open Chrome",

    True

)

history.add(

    "Search iPhone",

    True

)

history.add(

    "Click Buy",

    False,

    "Button not found"

)

print(

    history.last()

)

print()

print(

    history.successful()

)

print()

print(

    history.failed()

)