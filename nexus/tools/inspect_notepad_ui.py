"""Diagnostic only: print visible Notepad UIA controls and close only this process."""

import subprocess
import sys
from pathlib import Path
from time import sleep

# Direct script execution starts Python in tools/, so explicitly expose the project root.
PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from desktop.window_manager.launch_observer import LaunchObserver


observer = LaunchObserver()
before_handles = observer.snapshot()
process = subprocess.Popen(["notepad.exe"])
try:
    window = observer.wait_for_new_window("Notepad", before_handles, timeout=10)
    if window is None:
        raise RuntimeError("No new Notepad window appeared. Close existing Notepad windows and try again.")
    sleep(1)
    for control in window.descendants():
        try:
            if control.is_visible():
                info = control.element_info
                print(
                    f"type={info.control_type!r} name={control.window_text()!r} "
                    f"automation_id={info.automation_id!r} class={info.class_name!r}"
                )
        except Exception:
            continue
finally:
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
