"""Structured, privacy-aware browser page observation for the Brain platform."""

from dataclasses import asdict, dataclass


@dataclass
class InteractiveElement:
    role: str
    name: str
    tag: str
    selector_hint: str
    disabled: bool


@dataclass
class PageSnapshot:
    url: str
    title: str
    visible_text: str
    elements: list[InteractiveElement]

    def as_dict(self) -> dict:
        return asdict(self)


class PageObserver:
    """Extract browser-visible state without reading password values or cookies."""

    def inspect(self, page, max_text_length: int = 6000, max_elements: int = 200) -> PageSnapshot:
        data = page.evaluate(
            """({ maxText, maxElements }) => {
                const visible = (element) => {
                    const style = getComputedStyle(element);
                    const rect = element.getBoundingClientRect();
                    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
                };
                const nameOf = (element) => (
                    element.getAttribute('aria-label') || element.getAttribute('title') ||
                    element.labels?.[0]?.innerText || element.innerText ||
                    (element.type === 'password' ? '' : element.value) ||
                    element.getAttribute('placeholder') || element.getAttribute('name') || ''
                ).trim().replace(/\\s+/g, ' ').slice(0, 200);
                const selectorHint = (element) => {
                    if (element.id) return '#' + CSS.escape(element.id);
                    if (element.getAttribute('name')) return element.tagName.toLowerCase() + '[name="' + CSS.escape(element.getAttribute('name')) + '"]';
                    return element.tagName.toLowerCase();
                };
                const candidates = [...document.querySelectorAll('a, button, input, textarea, select, [role="button"], [role="link"], [contenteditable="true"]')]
                    .filter(visible).slice(0, maxElements).map((element) => ({
                        role: element.getAttribute('role') || (element.tagName === 'A' ? 'link' : element.tagName === 'BUTTON' ? 'button' : element.tagName.toLowerCase()),
                        name: nameOf(element), tag: element.tagName.toLowerCase(), selector_hint: selectorHint(element),
                        disabled: Boolean(element.disabled) || element.getAttribute('aria-disabled') === 'true'
                    }));
                return { text: (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, maxText), elements: candidates };
            }""",
            {"maxText": max_text_length, "maxElements": max_elements},
        )
        return PageSnapshot(
            url=page.url,
            title=page.title(),
            visible_text=data["text"],
            elements=[InteractiveElement(**element) for element in data["elements"]],
        )
