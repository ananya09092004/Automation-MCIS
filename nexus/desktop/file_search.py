"""Find a file by name/partial-name across common personal folders.

Deliberately searches the user's home directory tree (minus noisy
system/dev folders) rather than the whole drive -- scanning C:\\ end to
end is slow, frequently hits permission-denied errors on system folders,
and personal documents almost never live there anyway.
"""
import os
from pathlib import Path

_SKIP_DIR_NAMES = {
    "AppData", "Program Files", "Program Files (x86)", "Windows",
    "node_modules", "__pycache__", ".git", ".venv", "venv", "env",
    ".cache", "$Recycle.Bin", "System Volume Information",
}


def find_document(query: str, root: str | None = None, limit: int = 25) -> list[str]:
    root_path = Path(root) if root else Path.home()
    if not root_path.is_dir():
        return []

    query_lower = query.casefold()
    matches = []

    for current_dir, subdirs, files in os.walk(root_path):
        subdirs[:] = [d for d in subdirs if d not in _SKIP_DIR_NAMES and not d.startswith(".")]
        for name in files:
            if query_lower in name.casefold():
                matches.append(str(Path(current_dir) / name))
                if len(matches) >= limit:
                    return matches

    return matches
