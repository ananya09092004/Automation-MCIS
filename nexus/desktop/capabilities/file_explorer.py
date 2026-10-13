"""File Explorer capability pack; all destructive work remains approval-gated upstream."""

import os
import subprocess
from pathlib import Path

from desktop.file_manager import FileManager
from desktop.folder_manager import FolderManager


class FileExplorerCapability:
    def __init__(self):
        self.files = FileManager()
        self.folders = FolderManager()

    def open_path(self, path: str) -> bool:
        target = Path(path).resolve()
        if not target.exists():
            return False
        subprocess.Popen(["explorer.exe", str(target)])
        return True

    def reveal_file(self, path: str) -> bool:
        target = Path(path).resolve()
        if not target.is_file():
            return False
        subprocess.Popen(["explorer.exe", "/select,", str(target)])
        return True

    def list_items(self, path: str) -> list[dict]:
        folder = Path(path)
        if not folder.is_dir():
            return []
        return [{"name": item.name, "path": str(item), "kind": "folder" if item.is_dir() else "file"}
                for item in sorted(folder.iterdir(), key=lambda item: (not item.is_dir(), item.name.casefold()))]

    def open_file(self, path: str) -> bool:
        target = Path(path).resolve()
        if not target.is_file():
            return False
        os.startfile(str(target))
        return True

    def search(self, directory: str, query: str) -> list[dict]:
        root = Path(directory)
        if not root.is_dir():
            return []
        return [{"name": item.name, "path": str(item), "kind": "folder" if item.is_dir() else "file"}
                for item in root.rglob("*") if query.casefold() in item.name.casefold()]
