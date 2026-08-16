from dataclasses import dataclass
from PIL import Image


@dataclass
class ScreenFrame:

    image: Image.Image

    width: int

    height: int

    timestamp: float