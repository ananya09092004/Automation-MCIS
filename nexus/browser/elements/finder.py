from playwright.sync_api import Page
from browser.intelligence.models import ElementInfo

class ElementFinder:

    def _first_visible(self, locator):

        try:
            count = locator.count()

            for i in range(count):

                item = locator.nth(i)

                for i in range(count):

                    try:
                        item = locator.nth(i)

                        if item.is_visible() and item.is_enabled():
                            return item

                    except Exception:
                        continue

        except Exception:
            pass

        return None

    def __init__(self, page: Page):

        self.page = page

    def by_text(self, text: str):

        return self.page.get_by_text(text)

    def by_placeholder(self, text: str):

        return self.page.get_by_placeholder(text)

    def by_role(

        self,

        role: str,

        name: str | None = None

    ):

        if name:

            return self.page.get_by_role(

                role,

                name=name

            )

        return self.page.get_by_role(role)

    def by_label(self, text: str):

        return self.page.get_by_label(text)

    def by_selector(self, selector: str):

        return self.page.locator(selector)

    def first(self, locator):

        return locator.first

    def all(self, locator):

        return locator.all()

    def from_element(

        self,

        element: ElementInfo

    ):

        if element.element_id:

            locator = self.page.locator(

                f"#{element.element_id}"

            )

            if locator.count():

                visible = self._first_visible(locator)

                if visible:
                    return visible

        if element.name:

            locator = self.page.locator(

                f'[name="{element.name}"]'

            )

            if locator.count():

                visible = self._first_visible(locator)

                if visible:
                    return visible

        if element.aria_label:

            locator = self.page.get_by_label(

                element.aria_label

            )

            if locator.count():

                visible = self._first_visible(locator)

                if visible:
                    return visible

        if element.placeholder:

            locator = self.page.get_by_placeholder(

                element.placeholder

            )

            if locator.count():

                visible = self._first_visible(locator)

                if visible:
                    return visible

        if element.css_class:

            first_class = (

                element.css_class

                .split()

                [0]

            )

            locator = self.page.locator(

                f".{first_class}"

            )

            if locator.count():

                visible = self._first_visible(locator)

                if visible:
                    return visible

        if element.text:

            locator = self.page.get_by_text(

                element.text,

                exact=False

            )

            if locator.count():

                visible = self._first_visible(locator)

                if visible:
                    return visible

        return None