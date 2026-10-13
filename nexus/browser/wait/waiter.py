from playwright.sync_api import Page, Locator


class BrowserWait:

    def __init__(

        self,

        page: Page

    ):

        self.page = page

    def page_loaded(

        self,

        timeout: int = 30000

    ) -> bool:

        self.page.wait_for_load_state(

            "load",

            timeout=timeout

        )

        return True

    def network_idle(

        self,

        timeout: int = 30000

    ) -> bool:

        self.page.wait_for_load_state(

            "networkidle",

            timeout=timeout

        )

        return True

    def dom_ready(

        self,

        timeout: int = 30000

    ) -> bool:

        self.page.wait_for_load_state(

            "domcontentloaded",

            timeout=timeout

        )

        return True

    def element_visible(

        self,

        locator: Locator,

        timeout: int = 30000

    ) -> bool:

        locator.wait_for(

            state="visible",

            timeout=timeout

        )

        return True

    def element_hidden(

        self,

        locator: Locator,

        timeout: int = 30000

    ) -> bool:

        locator.wait_for(

            state="hidden",

            timeout=timeout

        )

        return True

    def url(

        self,

        url: str,

        timeout: int = 30000

    ) -> bool:

        self.page.wait_for_url(

            url,

            timeout=timeout

        )

        return True