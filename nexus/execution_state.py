"""In-memory state snapshots for verification and recovery; no credentials are retained."""

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any


@dataclass
class StateSnapshot:
    platform: str
    action: str
    timestamp: str
    values: dict[str, Any] = field(default_factory=dict)


class StateTracker:
    def __init__(self):
        self.history: list[StateSnapshot] = []

    def record(self, platform: str, action: str, **values: Any) -> StateSnapshot:
        safe_values = {key: value for key, value in values.items() if key not in {"password", "token", "otp", "cookie"}}
        snapshot = StateSnapshot(platform, action, datetime.now(timezone.utc).isoformat(), safe_values)
        self.history.append(snapshot)
        return snapshot

    def latest(self) -> StateSnapshot | None:
        return self.history[-1] if self.history else None
