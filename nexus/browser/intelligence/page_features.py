from dataclasses import dataclass


@dataclass
class PageFeatures:

    url: str

    title: str

    text: str

    forms: int

    buttons: int

    links: int

    inputs: int

    password_inputs: int

    search_inputs: int

    file_inputs: int

    tables: int

    dialogs: int

    headings: int

    interactive_elements: int