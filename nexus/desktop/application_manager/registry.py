import platform
import shutil
from pathlib import Path

from .windows_registry import WindowsRegistry


class RegistryDiscovery:

    def __init__(self):

        self.windows = WindowsRegistry()

    def find(self, app_name: str):

        system = platform.system()

        if system == "Windows":

            exe = self.windows.find(app_name)

            if exe:

                return exe

        exe = shutil.which(app_name)

        if exe:

            return Path(exe)

        return None