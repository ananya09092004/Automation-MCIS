from dataclasses import dataclass


@dataclass
class Action:

    action: str

    target: str | None = None

    value: str | None = None

    description: str | None = None