"""Regression test: importing/collecting the live-automation scratch test
modules must never perform real keyboard/desktop input.

This guards against a regression of the bug fixed in test_keyboard.py and
test_input_executor.py, where real pyautogui calls ran at module import
time -- meaning merely collecting the test suite (even under
`pytest -m "not live"`) typed text into whatever window had OS keyboard
focus.

It works by monkeypatching the real pyautogui primitives those modules
(transitively, via desktop.keyboard.KeyboardController) rely on to raise
if called, then freshly importing each module. If either module ever
regresses to calling these at import time instead of inside a
@pytest.mark.live-marked test function, this test fails loudly instead of
silently typing into the developer's/CI's focused window.
"""

import importlib
import sys

import pytest

LIVE_SCRATCH_TEST_MODULES = [
    "tests.test_keyboard",
    "tests.test_input_executor",
]


def _forbid_real_keyboard_input(monkeypatch):
    """Patch every pyautogui primitive KeyboardController uses to blow up
    if called, so any accidental import-time invocation is caught."""
    import pyautogui

    def _boom(*args, **kwargs):
        raise AssertionError(
            "Real keyboard automation (pyautogui) was invoked during "
            "module import/collection -- this must only happen inside a "
            "test function marked @pytest.mark.live."
        )

    for name in ("write", "press", "hotkey", "keyDown", "keyUp"):
        monkeypatch.setattr(pyautogui, name, _boom)


def _fresh_import(module_name):
    # Force a real (re-)import so any import-time side effect would
    # actually execute now, rather than reusing a module already cached
    # (and thus already imported once, harmlessly, earlier in the run).
    sys.modules.pop(module_name, None)
    return importlib.import_module(module_name)


@pytest.mark.parametrize("module_name", LIVE_SCRATCH_TEST_MODULES)
def test_live_scratch_module_import_performs_no_real_keyboard_input(
    monkeypatch, module_name
):
    _forbid_real_keyboard_input(monkeypatch)

    module = _fresh_import(module_name)

    assert module is not None
