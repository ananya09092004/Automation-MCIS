from dataclasses import dataclass


@dataclass
class PageAnalysis:

    title: str

    url: str

    buttons: int

    inputs: int

    textareas: int

    dropdowns: int

    links: int

    forms: int

    images: int