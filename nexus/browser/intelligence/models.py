from dataclasses import dataclass


@dataclass
class ElementInfo:

    # Basic

    tag: str
    text: str
    role: str

    # Input

    input_type: str
    placeholder: str
    name: str = ""
    value: str = ""

    # State

    enabled: bool = True
    visible: bool = True
    checked: bool = False
    selected: bool = False

    # Identity

    element_id: str = ""
    css_class: str = ""
    aria_label: str = ""
    title: str = ""

    # Navigation

    href: str = ""

    # Tables

    rows: int = 0
    columns: int = 0

    # Position

    x: float = 0
    y: float = 0
    width: float = 0
    height: float = 0

    # Hierarchy

    parent_tag: str = ""
    parent_role: str = ""

    # Metadata

    clickable: bool = False
    editable: bool = False
    score: float = 0