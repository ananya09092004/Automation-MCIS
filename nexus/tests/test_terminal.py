"""Live smoke test for DesktopExecutor's run_terminal action: runs a real
`python --version` subprocess through the desktop executor/router stack.

SAFETY: this test genuinely executes a shell command (subprocess.run with
shell=True) via TerminalController.run(). Only run it explicitly
(pytest -m live). Previously all of this ran at module import time with
no test function and no marker, so simply collecting this file (even
under `pytest -m "not live" -q`) executed a real terminal command --
exactly the kind of test-isolation gap already fixed for
test_automation.py/test_clipboard.py/test_input_executor.py/
test_keyboard.py elsewhere in this test suite.
"""

import pytest

from desktop.executor import DesktopExecutor


@pytest.mark.live
def test_run_terminal_executes_real_command():
    executor = DesktopExecutor()
    result = executor.execute(
        {
            "action": "run_terminal",
            "command": "python --version",
        }
    )
    assert result.data.stdout is not None or result.data.stderr is not None
