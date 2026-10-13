from dataclasses import dataclass


@dataclass
class UIElement:

    text: str

    confidence: float

    x1: int

    y1: int

    x2: int

    y2: int

    clickable: bool = False

    editable: bool = False

    selectable: bool = False

    enabled: bool = True

    visible: bool = True

    element_type: str = "unknown"

    @property
    def width(self):

        return self.x2 - self.x1

    @property
    def height(self):

        return self.y2 - self.y1

    @property
    def center_x(self):

        return (self.x1 + self.x2) // 2

    @property
    def center_y(self):

        return (self.y1 + self.y2) // 2