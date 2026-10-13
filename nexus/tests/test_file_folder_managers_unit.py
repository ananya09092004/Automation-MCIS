from desktop.file_manager.controller import FileManager
from desktop.folder_manager.controller import FolderManager


def test_file_manager_read_write_and_search(tmp_path):
    manager = FileManager()
    file_path = tmp_path / "notes" / "plan.txt"
    assert manager.write_file(str(file_path), "Nexus plan")
    assert manager.read_file(str(file_path)) == "Nexus plan"
    assert manager.search_file(str(tmp_path), "plan") == [str(file_path)]


def test_folder_manager_copy_and_search(tmp_path):
    manager = FolderManager()
    source = tmp_path / "source"
    destination = tmp_path / "destination"
    assert manager.create_folder(str(source))
    assert manager.copy_folder(str(source), str(destination))
    assert manager.search_folder(str(tmp_path), "dest") == [str(destination)]
