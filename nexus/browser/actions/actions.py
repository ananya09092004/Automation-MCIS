import time
from playwright.sync_api import Locator


class BrowserActions:

    def click(

        self,

        locator: Locator

    ) -> bool:

        locator.click()

        return True

    def fill(

        self,

        locator: Locator,

        text: str

    ) -> bool:

        locator.wait_for(state="visible")

        locator.fill(text)

        # Browser ko events process karne do
        locator.press("Tab")

        time.sleep(0.5)

        return True

    def type(

        self,

        locator: Locator,

        text: str,

        delay: int = 30

    ) -> bool:

        locator.press_sequentially(

            text,

            delay=delay

        )

        return True

    def press(

        self,

        locator: Locator,

        key: str

    ) -> bool:

        locator.press(key)

        return True

    def check(

        self,

        locator: Locator

    ) -> bool:

        locator.check()

        return True

    def uncheck(

        self,

        locator: Locator

    ) -> bool:

        locator.uncheck()

        return True

    def select(

        self,

        locator: Locator,

        value: str

    ) -> bool:

        locator.select_option(value)

        return True

    def hover(

        self,

        locator: Locator

    ) -> bool:

        locator.hover()

        return True

    def focus(

        self,

        locator: Locator

    ) -> bool:

        locator.focus()

        return True