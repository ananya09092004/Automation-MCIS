from desktop.file_manager import FileManager
from desktop.folder_manager import FolderManager


def test_path_verification_and_folder_listing(tmp_path):
    folders, files = FolderManager(), FileManager()
    folder = tmp_path / "workspace"; child = folder / "note.txt"
    assert folders.create_folder(str(folder))
    assert files.write_file(str(child), "Nexus")
    assert files.exists(str(child))
    assert folders.list_folder(str(folder)) == [str(child)]
