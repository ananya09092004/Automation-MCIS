from playwright.sync_api import Browser, BrowserContext, Page


class BrowserSession:

    def __init__(

        self,

        browser: Browser,

        context: BrowserContext

    ):

        self.browser = browser

        self.context = context

        self.current_page: Page | None = None

    def new_tab(

        self

    ) -> Page:

        self.current_page = self.context.new_page()

        return self.current_page

    def tabs(

        self

    ) -> list[Page]:

        return self.context.pages

    def active(

        self

    ) -> Page | None:

        return self.current_page

    def switch(

        self,

        index: int

    ) -> bool:

        pages = self.context.pages

        if index >= len(pages):

            return False

        self.current_page = pages[index]

        self.current_page.bring_to_front()

        return True

    def close_current(

        self

    ) -> bool:

        if self.current_page is None:

            return False

        self.current_page.close()

        pages = self.context.pages

        self.current_page = pages[-1] if pages else None

        return True

    def close_all(

        self

    ) -> bool:

        for page in list(self.context.pages):

            page.close()

        self.current_page = None

        return True

    def count(

        self

    ) -> int:

        return len(self.context.pages)

    def current_url(

        self

    ) -> str:

        if self.current_page is None:

            return ""

        return self.current_page.url

    def current_title(

        self

    ) -> str:

        if self.current_page is None:

            return ""

        return self.current_page.title()