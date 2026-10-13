from dataclasses import dataclass


@dataclass(frozen=True)
class WebsiteInfo:

    name: str

    aliases: tuple[str, ...]

    url: str

    search_box: str | None = None

    login_button: str | None = None