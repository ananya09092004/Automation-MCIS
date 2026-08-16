"""
Base Desktop Adapter

Every operating system adapter must inherit from this class.

Windows
Linux
macOS

must implement every method defined here.
"""

from abc import ABC, abstractmethod
from pathlib import Path
from typing import List, Optional


class BaseDesktopAdapter(ABC):

    # --------------------------------------------------
    # Application Control
    # --------------------------------------------------

    @abstractmethod
    def open_app(self, app_name: str) -> bool:
        pass

    @abstractmethod
    def close_app(self, app_name: str) -> bool:
        pass

    @abstractmethod
    def is_app_running(self, app_name: str) -> bool:
        pass

    @abstractmethod
    def get_running_apps(self) -> List[str]:
        pass

    # --------------------------------------------------
    # Window Management
    # --------------------------------------------------

    @abstractmethod
    def focus_window(self, title: str) -> bool:
        pass

    @abstractmethod
    def minimize_window(self, title: str) -> bool:
        pass

    @abstractmethod
    def maximize_window(self, title: str) -> bool:
        pass

    @abstractmethod
    def close_window(self, title: str) -> bool:
        pass

    # --------------------------------------------------
    # Mouse
    # --------------------------------------------------

    @abstractmethod
    def move_mouse(self, x: int, y: int) -> bool:
        pass

    @abstractmethod
    def click(self, button: str = "left") -> bool:
        pass

    @abstractmethod
    def double_click(self) -> bool:
        pass

    @abstractmethod
    def right_click(self) -> bool:
        pass

    @abstractmethod
    def scroll(self, amount: int) -> bool:
        pass

    # --------------------------------------------------
    # Keyboard
    # --------------------------------------------------

    @abstractmethod
    def type_text(self, text: str) -> bool:
        pass

    @abstractmethod
    def press_key(self, key: str) -> bool:
        pass

    @abstractmethod
    def hotkey(self, *keys: str) -> bool:
        pass

    # --------------------------------------------------
    # Clipboard
    # --------------------------------------------------

    @abstractmethod
    def copy(self) -> bool:
        pass

    @abstractmethod
    def paste(self) -> bool:
        pass

    @abstractmethod
    def get_clipboard_text(self) -> str:
        pass

    # --------------------------------------------------
    # Files
    # --------------------------------------------------

    @abstractmethod
    def file_exists(self, path: Path) -> bool:
        pass

    @abstractmethod
    def open_file(self, path: Path) -> bool:
        pass

    @abstractmethod
    def delete_file(self, path: Path) -> bool:
        pass

    # --------------------------------------------------
    # Folders
    # --------------------------------------------------

    @abstractmethod
    def open_folder(self, path: Path) -> bool:
        pass

    # --------------------------------------------------
    # Terminal
    # --------------------------------------------------

    @abstractmethod
    def execute_terminal_command(
        self,
        command: str
    ) -> tuple[bool, str]:
        pass

    # --------------------------------------------------
    # Screenshot
    # --------------------------------------------------

    @abstractmethod
    def take_screenshot(
        self,
        save_path: Optional[Path] = None
    ) -> Path:
        pass

    # --------------------------------------------------
    # Notifications
    # --------------------------------------------------

    @abstractmethod
    def show_notification(
        self,
        title: str,
        message: str
    ) -> bool:
        pass