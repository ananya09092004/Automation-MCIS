"""Persistent Playwright storage-state paths; never stores credentials itself."""

from pathlib import Path

# The session name platform_executor.py auto-loads/auto-saves on every
# browser start/stop when the caller doesn't explicitly request a
# different named session -- this is what makes "already logged into
# Gmail" persist across separate Nexus runs without the user having to
# say "save session" / "load session" every time.
DEFAULT_SESSION_NAME = "default"


class BrowserSessionStore:
    def __init__(self, root: str = "browser/sessions"):
        self.root = Path(root)

    def path_for(self, name: str) -> str:
        safe = "".join(character for character in name if character.isalnum() or character in "-_ ").strip()
        if not safe:
            raise ValueError("Session name must contain letters or numbers.")
        self.root.mkdir(parents=True, exist_ok=True)
        return str(self.root / f"{safe}.json")

    def default_path(self) -> str:
        return self.path_for(DEFAULT_SESSION_NAME)