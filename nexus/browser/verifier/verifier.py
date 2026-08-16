from playwright.sync_api import Page


class BrowserVerifier:

    def __init__(

        self,

        page: Page

    ):

        self.page = page

    # -------------------------
    # URL
    # -------------------------

    def url_is(self, expected: str):

        return self.page.url == expected

    def url_contains(self, text: str):

        return text.lower() in self.page.url.lower()

    # -------------------------
    # TITLE
    # -------------------------

    def title_is(self, expected: str):

        return self.page.title() == expected

    def title_contains(self, text: str):

        return text.lower() in self.page.title().lower()

    # -------------------------
    # TEXT
    # -------------------------

    def text_exists(self, text: str):

        return self.page.get_by_text(

            text,

            exact=False

        ).count() > 0

    # -------------------------
    # ELEMENT
    # -------------------------

    def element_exists(self, selector: str):

        return self.page.locator(

            selector

        ).count() > 0

    def element_visible(self, selector: str):

        locator = self.page.locator(selector)

        return (

            locator.count() > 0

            and

            locator.first.is_visible()

        )

    def element_enabled(self, selector: str):

        locator = self.page.locator(selector)

        return (

            locator.count() > 0

            and

            locator.first.is_enabled()

        )

    # -------------------------
    # INPUT
    # -------------------------

    def input_value(

        self,

        selector,

        expected

    ):

        locator = self.page.locator(selector)

        if locator.count() == 0:

            return False

        return (

            locator.first.input_value()

            == expected

        )

    # -------------------------
    # PAGE
    # -------------------------

    def page_loaded(self):

        try:

            self.page.wait_for_load_state(

                "networkidle",

                timeout=5000

            )

            return True

        except Exception:

            return False

    def loading(self):

        return (

            self.page.locator(

                '[aria-busy="true"],.loading,.spinner'

            ).count()

            >

            0

        )

    def dialog_open(self):

        return (

            self.page.locator(

                '[role="dialog"],dialog,[aria-modal="true"]'

            ).count()

            >

            0

        )

    def has_error(self):

        body = self.page.locator(

            "body"

        ).inner_text().lower()

        keywords = [

            "error",

            "failed",

            "something went wrong",

            "exception",

            "404",

            "500"

        ]

        return any(

            word in body

            for word in keywords

        )

    def dom_changed(

        self,

        previous_count

    ):

        current = self.page.locator("*").count()

        return current != previous_count