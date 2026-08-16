from dataclasses import dataclass
from pathlib import Path
from typing import Optional


@dataclass
class ApplicationInfo:
    """
    Represents an installed application.
    """

    name: str

    executable: Optional[Path]

    installed: bool

    version: Optional[str] = None

    install_location: Optional[Path] = None

    source: Optional[str] = None