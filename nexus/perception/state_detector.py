"""Conservative read-only state detection from OCR-visible desktop text."""

from dataclasses import asdict, dataclass
from typing import Iterable


@dataclass(frozen=True)
class ScreenState:
    state: str
    confidence: float
    matches: list[dict]
    safe_to_act: bool

    def as_dict(self) -> dict:
        return asdict(self)


class ScreenStateDetector:
    """Classifies a screen as error, loading, success, or unknown.

    It does not click anything.  An error/loading result deliberately tells the
    executor not to continue with blind follow-up actions.
    """

    ERROR_WORDS = ("error", "failed", "failure", "something went wrong", "unable", "exception")
    LOADING_WORDS = ("loading", "please wait", "processing", "working...")
    SUCCESS_WORDS = ("success", "completed", "saved", "done", "uploaded")

    def __init__(self, observer=None):
        self._observer = observer

    def _elements(self) -> Iterable:
        if self._observer is None:
            from perception.observer import ScreenObserver
            self._observer = ScreenObserver()
        return self._observer.observe()

    def detect(self) -> ScreenState:
        visible = [(item.text.strip(), float(item.confidence)) for item in self._elements() if item.text.strip()]
        for state, words in (("error", self.ERROR_WORDS), ("loading", self.LOADING_WORDS), ("success", self.SUCCESS_WORDS)):
            matches = [
                {"text": text, "confidence": confidence}
                for text, confidence in visible
                if any(word in text.casefold() for word in words)
            ]
            if matches:
                confidence = max(item["confidence"] for item in matches)
                return ScreenState(state, confidence, matches, safe_to_act=state == "success")
        return ScreenState("unknown", 0.0, [], safe_to_act=False)
