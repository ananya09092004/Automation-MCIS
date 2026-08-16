"""Evidence capture for execution results; screenshots contain no OCR extraction by default."""

from datetime import datetime, timezone
from pathlib import Path


class EvidenceCollector:
    def __init__(self, root: str = "artifacts/evidence"):
        self.root = Path(root)

    def _path(self, platform: str, action: str) -> Path:
        self.root.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        return self.root / f"{stamp}_{platform}_{action}.png"

    def desktop_screenshot(self, action: str) -> str:
        from desktop.screenshot import ScreenshotController
        path = self._path("desktop", action)
        ScreenshotController().save(str(path))
        return str(path)

    def browser_screenshot(self, page, action: str) -> str:
        path = self._path("browser", action)
        page.screenshot(path=str(path), full_page=False)
        return str(path)
