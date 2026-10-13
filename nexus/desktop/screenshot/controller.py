from mss import mss
from PIL import Image


class ScreenshotController:

    def capture(self):

        with mss() as sct:

            monitor = sct.monitors[1]

            shot = sct.grab(monitor)

            return Image.frombytes(

                "RGB",

                shot.size,

                shot.rgb

            )

    def save(
        self,
        path
    ):

        image = self.capture()

        image.save(path)

        return path

    def capture_region(self, left: int, top: int, width: int, height: int):
        with mss() as sct:
            shot = sct.grab({"left": left, "top": top, "width": width, "height": height})
            return Image.frombytes("RGB", shot.size, shot.rgb)

    def capture_active_window(self, path: str):
        """Capture only the currently active app window and return safe metadata."""
        import pygetwindow

        window = pygetwindow.getActiveWindow()
        if window is None or window.width <= 0 or window.height <= 0:
            return None
        image = self.capture_region(window.left, window.top, window.width, window.height)
        image.save(path)
        return {"path": str(path), "title": window.title, "width": window.width, "height": window.height}
