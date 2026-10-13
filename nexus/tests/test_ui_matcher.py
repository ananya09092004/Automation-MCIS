"""Live scratch script -- converted from unmarked top-level code that
ran automatically at mere module import/collection time (so simply
running `pytest -m "not live" -q`, or even `--collect-only`, executed
real actions/side effects with no explicit opt-in) into a proper
@pytest.mark.live-marked test function.

Same test-isolation gap already fixed for test_terminal.py/
test_keyboard.py/test_input_executor.py (P2.16 audit) -- this file has
no assertions and isn't a real regression test, it's a developer
scratch script that happens to be named test_*.py, so it must never
run as a side effect of ordinary (non-live) test collection.
"""
import pytest


@pytest.mark.live
def test_ui_matcher_live_scratch():
    from perception import Screen
    from perception.ocr import OCREngine
    from perception.ui_detector.models import UIElement
    from perception.ui_detector.matcher import UIMatcher


    screen = Screen()

    ocr = OCREngine()

    matcher = UIMatcher()

    frame = screen.capture()

    items = ocr.read(frame.image)

    ui = []

    for item in items:

        ui.append(

            UIElement(

                text=item.text,
                confidence=item.confidence,
                x1=item.x1,
                y1=item.y1,
                x2=item.x2,
                y2=item.y2

            )

        )

    result = matcher.classify_all(ui)

    for r in result:

        if r.clickable or r.editable:

            print(r)
