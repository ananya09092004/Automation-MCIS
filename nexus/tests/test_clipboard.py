"""Live smoke test for ClipboardController: mutates the REAL system
clipboard (copy/clear), overwriting whatever the user currently has
copied.

SAFETY: only run this explicitly (pytest -m live). Previously all of
this ran at module import time with no test function and no marker, so
simply collecting this file (even under `pytest -m "not live" -q`)
silently overwrote the real OS clipboard.
"""

import pytest

from desktop.clipboard import ClipboardController


@pytest.mark.live
def test_clipboard_copy_paste_and_clear_round_trip():
    clipboard = ClipboardController()
    clipboard.copy("Hello Nexus")
    assert clipboard.paste() == "Hello Nexus"
    assert clipboard.has_text() is True
    clipboard.clear()
    assert clipboard.has_text() is False
