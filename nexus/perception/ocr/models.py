from dataclasses import dataclass


@dataclass
class OCRText:

    text: str
    confidence: float
    x1: int
    y1: int
    x2: int
    y2: int