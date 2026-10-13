"""Live smoke test for AutomationEngine: runs a real type_text Action
through the desktop executor/router stack (the lower-level automation
engine, separate from the UIA accessibility driver exercised by
test_desktop_accessibility_contract.py / test_live_notepad_ui_automation.py).

SAFETY: this test types into whatever window currently has OS keyboard
focus -- it does not launch or target a specific application/window.
Only run it explicitly (pytest -m live). Previously all of this ran at
module import time with no test function and no marker, so simply
collecting this file (even under `pytest -m "not live" -q`) executed a
real type_text action.
"""

import pytest

from desktop.automation import AutomationEngine
from desktop.automation.models import Action


@pytest.mark.live
def test_automation_engine_runs_type_text_action():
    engine = AutomationEngine()
    actions = [Action(action="type_text", text="Hello Nexus")]
    results = engine.run(actions)
    assert len(results) == 1
    assert results[0].success, results[0].message
