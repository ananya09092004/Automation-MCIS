from desktop.clipboard import ClipboardController

clipboard = ClipboardController()

clipboard.copy("Hello Nexus")

print(clipboard.paste())

print(clipboard.has_text())

clipboard.clear()

print(clipboard.has_text())