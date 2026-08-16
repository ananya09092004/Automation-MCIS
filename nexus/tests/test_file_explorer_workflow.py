from desktop.capabilities.file_explorer import FileExplorerCapability
from desktop.file_manager import FileManager
from desktop.folder_manager import FolderManager


def test_file_explorer_workflow_create_copy_move_search_list(tmp_path):
    files = FileManager()
    folders = FolderManager()
    explorer = FileExplorerCapability()
    source = tmp_path / "source"
    destination = tmp_path / "destination"
    assert folders.create_folder(str(source))
    assert folders.create_folder(str(destination))
    original = source / "plan.txt"
    assert files.write_file(str(original), "Nexus")
    copied = destination / "plan-copy.txt"
    assert files.copy_file(str(original), str(copied))
    moved = destination / "plan-moved.txt"
    assert files.move_file(str(copied), str(moved))
    assert not copied.exists()
    assert moved.exists()
    assert files.search_file(str(tmp_path), "moved") == [str(moved)]
    assert explorer.list_items(str(destination)) == [{"name": "plan-moved.txt", "path": str(moved), "kind": "file"}]
