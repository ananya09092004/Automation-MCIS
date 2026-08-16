"""Safe File Explorer smoke test; its filesystem work stays inside pytest's temp folder."""

from time import sleep

import pytest

from desktop.capabilities.file_explorer import FileExplorerCapability
from desktop.file_manager import FileManager
from desktop.folder_manager import FolderManager
from desktop.process_manager.controller import ProcessManager


@pytest.mark.live
def test_nexus_opens_a_temporary_folder_in_file_explorer(tmp_path):
    """Create, list, open, and verify a temporary folder without changing user data."""
    folders, files, explorer = FolderManager(), FileManager(), FileExplorerCapability()
    test_folder = tmp_path / "nexus-explorer-live"
    test_file = test_folder / "visible.txt"
    assert folders.create_folder(str(test_folder))
    assert files.write_file(str(test_file), "temporary Explorer workflow")
    assert explorer.list_items(str(test_folder)) == [
        {"name": "visible.txt", "path": str(test_file), "kind": "file"}
    ]

    assert explorer.open_path(str(test_folder))
    sleep(1)
    assert ProcessManager().exists("explorer.exe"), "File Explorer did not start."
    assert test_file.is_file()
