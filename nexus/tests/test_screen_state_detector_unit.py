from types import SimpleNamespace

from perception.state_detector import ScreenStateDetector


class FakeObserver:
    def __init__(self, items):
        self.items = items

    def observe(self):
        return self.items


def test_error_state_stops_follow_up_actions():
    detector = ScreenStateDetector(FakeObserver([SimpleNamespace(text="Upload failed", confidence=0.94)]))
    result = detector.detect()
    assert result.state == "error"
    assert result.confidence == 0.94
    assert not result.safe_to_act


def test_success_state_can_be_reported():
    detector = ScreenStateDetector(FakeObserver([SimpleNamespace(text="Saved successfully", confidence=0.88)]))
    result = detector.detect()
    assert result.state == "success"
    assert result.safe_to_act
