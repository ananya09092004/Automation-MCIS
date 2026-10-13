from enum import Enum


class Platform(Enum):
    WINDOWS = "windows"
    LINUX = "linux"
    MACOS = "macos"


class Status(Enum):
    SUCCESS = "success"
    FAILED = "failed"


class WindowState(Enum):
    NORMAL = "normal"
    MINIMIZED = "minimized"
    MAXIMIZED = "maximized"


class MouseButton(Enum):
    LEFT = "left"
    RIGHT = "right"
    MIDDLE = "middle"