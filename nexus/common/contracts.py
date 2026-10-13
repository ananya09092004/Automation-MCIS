"""Platform-neutral contracts shared by browser and desktop execution."""

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class RiskLevel(str, Enum):
    LOW = "low"
    HIGH = "high"


@dataclass
class ExecutionAction:
    """One action supplied by the orchestrator after task planning."""

    platform: str
    action: str
    target: dict[str, Any] = field(default_factory=dict)
    value: Any = None
    parameters: dict[str, Any] = field(default_factory=dict)
    risk: RiskLevel = RiskLevel.LOW
    approval_token: str | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ExecutionAction":
        payload = dict(data)
        risk = payload.get("risk", RiskLevel.LOW)
        if not isinstance(risk, RiskLevel):
            risk = RiskLevel(risk)
        payload["risk"] = risk
        return cls(**payload)


@dataclass
class ExecutionResult:
    success: bool
    platform: str
    action: str
    message: str
    data: Any = None
    evidence: dict[str, Any] = field(default_factory=dict)
    error: str | None = None
