from desktop.file_manager import FileManager
from desktop.folder_manager import FolderManager


class RollbackEngine:

    def __init__(self):

        self.files = FileManager()

        self.folders = FolderManager()

    def rollback(self, action):

        name = action.action

        if name == "create_file":

            return self.files.delete_file(

                action.path

            )

        elif name == "create_folder":

            return self.folders.delete_folder(

                action.path

            )

        return True