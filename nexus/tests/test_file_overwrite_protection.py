"""Regression tests for write_file overwrite detection.

Locks in the fix where overwriting an existing file with real content is
now reported via `.overwrote_existing_content` on the action result
(desktop/executor/router.py), instead of silently clobbering it with no
signal anywhere that anything was lost.

FileManager itself (desktop/file_manager/controller.py) has zero
Windows-only imports (just pathlib/shutil), so the core logic is tested
directly against a real filesystem (pytest's tmp_path) -- no mocking
needed for that part. The ActionRouter dispatch wrapper IS tested with
Windows-only dependencies mocked, since importing it pulls in the
registry/app-controller chain that needs winreg.
"""

import sys
import types

from desktop.file_manager.controller import FileManager


# ---------------------------------------------------------------------
# Direct FileManager tests -- real filesystem, no mocking needed at all.
# ---------------------------------------------------------------------

def test_file_has_content_false_for_missing_file(tmp_path):
    target = tmp_path / "does_not_exist.txt"
    assert FileManager().file_has_content(str(target)) is False


def test_file_has_content_false_for_empty_file(tmp_path):
    target = tmp_path / "empty.txt"
    target.touch()
    assert FileManager().file_has_content(str(target)) is False


def test_file_has_content_true_for_existing_content(tmp_path):
    target = tmp_path / "important.txt"
    target.write_text("some important existing content")
    assert FileManager().file_has_content(str(target)) is True


def test_write_file_still_writes_regardless_of_prior_content(tmp_path):
    """write_file() itself is unchanged -- it still performs the write.
    The overwrite SIGNAL is added at the router dispatch layer (tested
    below), not by blocking the write here."""
    target = tmp_path / "note.txt"
    target.write_text("old content")
    ok = FileManager().write_file(str(target), "new content")
    assert ok is True
    assert target.read_text() == "new content"


# ---------------------------------------------------------------------
# ActionRouter dispatch-layer test -- confirms the overwrite flag is
# actually surfaced on the result, with Windows-only deps mocked so this
# can run outside Windows.
# ---------------------------------------------------------------------

def _load_action_router_with_mocked_windows_deps():
    mock_map = {
        "desktop.app_controller.controller": {"AppController": lambda: None},
        "desktop.window_manager.manager": {"WindowManager": lambda: None},
        "desktop.process_manager.controller": {"ProcessManager": lambda: None},
        "desktop.keyboard.controller": {"KeyboardController": lambda: None},
        "desktop.mouse.controller": {"MouseController": lambda: None},
        "desktop.clipboard.controller": {"ClipboardController": lambda: None},
        "desktop.terminal": {"TerminalController": lambda: None},
        "desktop.notification.controller": {"NotificationController": lambda: None},
        "desktop.screenshot.controller": {"ScreenshotController": lambda: None},
        "desktop.folder_manager": {"FolderManager": lambda: None},
    }
    for name, attrs in mock_map.items():
        if name in sys.modules:
            continue
        module = types.ModuleType(name)
        for attr_name, value in attrs.items():
            setattr(module, attr_name, value)
        sys.modules[name] = module

    from desktop.executor.router import ActionRouter
    return ActionRouter()


def test_write_file_dispatch_reports_overwrite_of_real_content(tmp_path):
    router = _load_action_router_with_mocked_windows_deps()
    target = tmp_path / "existing_doc.txt"
    target.write_text("original important content")

    result = router.execute({"action": "write_file", "path": str(target), "content": "replacement content"})

    assert result.success is True
    assert result.overwrote_existing_content is True, "must report that real existing content was overwritten"
    assert target.read_text() == "replacement content"


def test_write_file_dispatch_does_not_falsely_report_overwrite_for_new_file(tmp_path):
    router = _load_action_router_with_mocked_windows_deps()
    target = tmp_path / "brand_new.txt"  # does not exist yet

    result = router.execute({"action": "write_file", "path": str(target), "content": "first content"})

    assert result.success is True
    assert result.overwrote_existing_content is False, "a brand-new file must not be reported as an overwrite"
