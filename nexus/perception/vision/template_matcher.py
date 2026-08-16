"""Reliable template matching for icon-only UI controls."""

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class TemplateMatch:
    x: int
    y: int
    width: int
    height: int
    confidence: float


class TemplateMatcher:
    def find(self, image, template_path: str, minimum_confidence: float = 0.85) -> TemplateMatch | None:
        """Find a reference icon in a PIL screenshot without clicking it."""
        try:
            import cv2
            import numpy as np
        except ImportError as error:
            raise RuntimeError("OpenCV and NumPy are required for image matching.") from error

        path = Path(template_path)
        if not path.is_file():
            raise FileNotFoundError(path)
        screenshot = cv2.cvtColor(np.array(image.convert("RGB")), cv2.COLOR_RGB2BGR)
        # PIL decoding supports Windows paths and Unicode filenames consistently.
        from PIL import Image
        template = cv2.cvtColor(np.array(Image.open(path).convert("RGB")), cv2.COLOR_RGB2BGR)
        height, width = template.shape[:2]
        if height > screenshot.shape[0] or width > screenshot.shape[1]:
            return None
        result = cv2.matchTemplate(screenshot, template, cv2.TM_CCOEFF_NORMED)
        _, confidence, _, location = cv2.minMaxLoc(result)
        if confidence < minimum_confidence:
            return None
        return TemplateMatch(location[0] + width // 2, location[1] + height // 2, width, height, float(confidence))
