__all__ = ["Screen", "ScreenObserver", "TemplateMatcher", "ScreenStateDetector"]


def __getattr__(name):
    """Avoid loading OCR/screenshot dependencies until a visual feature is used."""
    if name == "Screen":
        from .screen import Screen
        return Screen
    if name == "ScreenObserver":
        from .observer import ScreenObserver
        return ScreenObserver
    if name == "TemplateMatcher":
        from .vision import TemplateMatcher
        return TemplateMatcher
    if name == "ScreenStateDetector":
        from .state_detector import ScreenStateDetector
        return ScreenStateDetector
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
