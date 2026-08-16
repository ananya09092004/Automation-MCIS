from pathlib import Path
import shutil


class FolderManager:

    def create_folder(self, path: str) -> bool:

        try:

            folder = Path(path)

            folder.mkdir(

                parents=True,

                exist_ok=True

            )

            return folder.exists()

        except:

            return False

    def delete_folder(self, path: str) -> bool:

        try:

            folder = Path(path)

            if not folder.exists():

                return False

            shutil.rmtree(folder)

            return True

        except:

            return False

    def rename_folder(

        self,

        source: str,

        new_name: str

    ) -> bool:

        try:

            source = Path(source)

            target = source.parent / new_name

            source.rename(target)

            return True

        except:

            return False

    def move_folder(

        self,

        source: str,

        destination: str

    ) -> bool:

        try:

            shutil.move(

                source,

                destination

            )

            return True

        except:

            return False

    def copy_folder(self, source: str, destination: str) -> bool:
        try:
            shutil.copytree(source, destination, dirs_exist_ok=True)
            return True
        except OSError:
            return False

    def search_folder(self, directory: str, query: str) -> list[str]:
        root = Path(directory)
        if not root.is_dir():
            return []
        return [str(path) for path in root.rglob("*") if path.is_dir() and query.lower() in path.name.lower()]

    def list_folder(self, path: str) -> list[str]:
        folder = Path(path)
        if not folder.is_dir():
            return []
        return [str(item) for item in sorted(folder.iterdir(), key=lambda item: (not item.is_dir(), item.name.casefold()))]

    def exists(

        self,

        path: str

    ) -> bool:

        return Path(path).exists()
