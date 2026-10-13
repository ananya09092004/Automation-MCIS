from .capture import ScreenCapture


class Screen:

    def __init__(self):

        self.capture_engine = ScreenCapture()

    def capture(self):

        return self.capture_engine.capture()

    def save(

        self,

        path: str

    ):

        return self.capture_engine.save(path)