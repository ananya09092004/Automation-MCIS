from dataclasses import dataclass
from typing import Any


@dataclass
class ActionResult:

    success: bool

    action: str

    message: str

    data: Any = None