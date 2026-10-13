from dataclasses import dataclass
from typing import Any


@dataclass
class Action:

    action: str

    # Generic fields
    target: str = ""
    value: Any = None

    # App
    app: str = ""

    # File / Folder
    path: str = ""
    source: str = ""
    destination: str = ""
    new_name: str = ""

    # Mouse
    x: int = 0
    y: int = 0
    amount: int = 500

    # Keyboard
    text: str = ""
    key: str = ""
    keys: tuple = ()

    # Window
    title: str = ""

    # Terminal
    command: str = ""
    cwd: str | None = None

    # Notification
    message: str = ""

    # Process
    pid: int = 0