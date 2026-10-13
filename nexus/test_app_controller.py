from desktop.application_manager.discovery import ApplicationDiscovery

discovery = ApplicationDiscovery()

for app in [

    "python",

    "git",

    "code",

    "chrome",

    "notepad"

]:

    print(discovery.discover(app))