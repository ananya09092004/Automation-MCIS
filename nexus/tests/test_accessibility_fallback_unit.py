from desktop.accessibility.driver import DesktopAccessibilityDriver, TargetEvidence, TargetNotFoundError


class FallbackDriver(DesktopAccessibilityDriver):
    def __init__(self): super().__init__(); self.calls = []
    def _find_accessible(self, target): self.calls.append("uia"); return None
    def _image_click(self, target): self.calls.append("image"); return TargetEvidence("image", "icon", confidence=.95)
    def _ocr_click(self, target):
        self.calls.append("ocr")
        if "text" not in target:
            raise TargetNotFoundError("No OCR text target")
        return TargetEvidence("ocr", target["text"], confidence=.9)


def test_image_fallback_runs_after_uia_for_icon_only_target():
    driver = FallbackDriver()
    result = driver.click({"window_title": "Demo", "image_path": "icon.png"})
    assert result.method == "image"
    assert driver.calls == ["uia", "image"]


def test_ocr_fallback_runs_after_uia_when_no_icon_is_provided():
    driver = FallbackDriver()
    result = driver.click({"window_title": "Demo", "text": "Continue", "minimum_confidence": .8})
    assert result.method == "ocr"
    assert driver.calls == ["uia", "ocr"]


def test_no_target_evidence_blocks_a_click():
    driver = FallbackDriver()
    try:
        driver.click({"window_title": "Demo"})
    except TargetNotFoundError:
        return
    raise AssertionError("A target without UIA, image, or OCR evidence must not be clicked")
