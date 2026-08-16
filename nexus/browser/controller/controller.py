from browser.engines import BrowserEngine


class BrowserController:

    def __init__(self):

        self.engine = BrowserEngine()

        self.page = None

    def start(

        self,

        browser="chromium",

        headless=False,
        storage_state_path=None

    ):

        self.engine.start(

            browser,

            headless,
            storage_state_path

        )

        self.page = self.engine.new_page()

        return True

    def stop(self):

        self.engine.stop()

        self.page = None

        return True

    def open(

        self,

        url: str

    ):

        self.page.goto(

            url,

            wait_until="domcontentloaded"

        )

        return True

    def refresh(self):

        self.page.reload()

        return True

    def back(self):

        self.page.go_back()

        return True

    def forward(self):

        self.page.go_forward()

        return True

    def title(self):

        return self.page.title()

    def current_url(self):

        return self.page.url

    def new_tab(self):
        self.page = self.engine.new_page()
        return self.page

    def tabs(self):
        return self.engine.context.pages if self.engine.context else []

    def switch_tab(self, index: int):
        tabs = self.tabs()
        if index < 0 or index >= len(tabs):
            return False
        self.page = tabs[index]
        self.page.bring_to_front()
        return True

    def close_tab(self, index: int | None = None):
        tabs = self.tabs()
        if not tabs:
            return False
        page = self.page if index is None else tabs[index]
        page.close()
        remaining = self.tabs()
        self.page = remaining[-1] if remaining else None
        return True
