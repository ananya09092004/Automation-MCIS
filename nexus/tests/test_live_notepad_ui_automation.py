"""Explicit live smoke test: creates no files and closes only its own Notepad process."""

import subprocess
from time import sleep

import pytest

from common import ExecutionAction
from desktop.platform_executor import DesktopPlatformExecutor


@pytest.mark.live
def test_nexus_can_control_its_own_notepad_window():
    pytest.importorskip("pywinauto")
    from desktop.window_manager.launch_observer import LaunchObserver

    observer = LaunchObserver()
    before_handles = observer.snapshot()
    process = subprocess.Popen(["notepad.exe"])
    window = None
    editor = None
    try:
        window = observer.wait_for_new_window("Notepad", before_handles, timeout=10)
        assert window is not None, "No new Notepad window appeared. Close existing Notepad windows and try again."
        editors = [control for control in window.descendants(control_type="Document") if control.is_visible()]
        assert editors, "Notepad did not expose its Document editor control."
        editor = editors[0]
        result = DesktopPlatformExecutor().execute(ExecutionAction(
            platform="desktop",
            action="fill_target",
            target={"window_title": ".*Notepad.*", "control_type": "Document"},
            value="Nexus desktop automation smoke test",
        ))
        assert result.success, result.error
        assert result.evidence["method"] == "uia"
        sleep(0.2)
        status_text = [control.window_text() for control in window.descendants(control_type="Text")]
        assert any("characters" in text and not text.strip().startswith("0 characters") for text in status_text)
    finally:
        if editor is not None:
            try:
                editor.click_input()
                editor.type_keys("^a{BACKSPACE}", set_foreground=True)
            except Exception:
                pass
        if window is not None:
            try:
                window.close()
            except Exception:
                pass
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
