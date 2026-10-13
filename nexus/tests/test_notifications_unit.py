from desktop.notification.controller import NotificationController


class FakeToast:
    def __init__(self):
        self.shown = []

    def show_toast(self, title, message, duration, threaded):
        self.shown.append((title, message, duration, threaded))


def test_nexus_notification_history_is_readable_and_clearable():
    toast = FakeToast()
    notifications = NotificationController(toast=toast)
    assert notifications.show("Nexus", "Finished", duration=1)
    assert toast.shown == [("Nexus", "Finished", 1, False)]
    history = notifications.read_history()
    assert history[0]["title"] == "Nexus"
    assert history[0]["message"] == "Finished"
    assert notifications.clear_history()
    assert notifications.read_history() == []
