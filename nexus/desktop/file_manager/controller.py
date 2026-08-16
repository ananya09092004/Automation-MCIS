from pathlib import Path
import shutil


class FileManager:

    def create_file(self, path: str) -> bool:

        try:

            file = Path(path)

            file.parent.mkdir(
                parents=True,
                exist_ok=True
            )

            file.touch(
                exist_ok=True
            )

            return file.exists()

        except:

            return False

    def delete_file(self, path: str) -> bool:

        try:

            file = Path(path)

            if not file.exists():

                return False

            file.unlink()

            return True

        except:

            return False

    def move_file(
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

    def copy_file(
        self,
        source: str,
        destination: str
    ) -> bool:

        try:

            shutil.copy2(
                source,
                destination
            )

            return True

        except:

            return False

    def rename_file(
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

    def exists(
        self,
        path: str
    ) -> bool:

        return Path(path).exists()

    def read_file(self, path: str, encoding: str = "utf-8") -> str:
        return Path(path).read_text(encoding=encoding)

    def write_file(self, path: str, content: str, encoding: str = "utf-8") -> bool:
        try:
            file = Path(path)
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(content, encoding=encoding)
            return True
        except OSError:
            return False

    def search_file(self, directory: str, query: str) -> list[str]:
        root = Path(directory)
        if not root.is_dir():
            return []
        return [str(path) for path in root.rglob("*") if path.is_file() and query.lower() in path.name.lower()]
