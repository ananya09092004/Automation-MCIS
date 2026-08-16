from desktop.automation.session import SessionManager

session = SessionManager()

session.set_active_app("chrome")

session.set_active_window("Google Chrome")

session.set_task("Shopping")

session.add_action("Open Chrome")

session.add_action("Search iPhone")

print(session.get_active_app())

print(session.get_active_window())

print(session.get_task())

print(session.history())