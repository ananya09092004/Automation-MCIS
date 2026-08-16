"""Persistent Playwright storage-state paths; never stores credentials itself."""

from pathlib import Path


class BrowserSessionStore:
    def __init__(self, root: str = "browser/sessions"):
        self.root = Path(root)

    def path_for(self, name: str) -> str:
        safe = "".join(character for character in name if character.isalnum() or character in "-_ ").strip()
        if not safe:
            raise ValueError("Session name must contain letters or numbers.")
        self.root.mkdir(parents=True, exist_ok=True)
        return str(self.root / f"{safe}.json")
