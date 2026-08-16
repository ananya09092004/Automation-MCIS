from datetime import datetime, timezone


class NotificationController:

    def __init__(self, toast=None):
        # Import lazily: reading Nexus history should work even where a toast
        # provider is unavailable (for example, a headless test environment).
        self.toast = toast
        self.history = []

    def _provider(self):
        if self.toast is None:
            from win10toast import ToastNotifier
            self.toast = ToastNotifier()
        return self.toast

    def show(

        self,

        title,

        message,

        duration=5

    ):

        self._provider().show_toast(

            title,

            message,

            duration=duration,

            threaded=False

        )

        self.history.append({
            "title": str(title), "message": str(message),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })
        return True

    def read_history(self, limit: int = 50):
        """Read only notifications created by Nexus in this running process."""
        return list(self.history[-max(0, limit):])

    def clear_history(self) -> bool:
        self.history.clear()
        return True
