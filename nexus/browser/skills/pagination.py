from browser.interaction import SafeExecutor


class PaginationSkill:

    NEXT_SELECTORS = [

        'a[rel="next"]',

        'button[aria-label*="Next" i]',

        'a[aria-label*="Next" i]',

        'button:has-text("Next")',

        'a:has-text("Next")',

        'button:has-text(">")',

        'a:has-text(">")'

    ]

    PREVIOUS_SELECTORS = [

        'a[rel="prev"]',

        'button[aria-label*="Previous" i]',

        'a[aria-label*="Previous" i]',

        'button:has-text("Previous")',

        'a:has-text("Previous")'

    ]

    def __init__(

        self,

        page

    ):

        self.page = page

        self.executor = SafeExecutor(page)

    def _click(

        self,

        selectors

    ):

        for selector in selectors:

            locator = self.page.locator(selector).first

            try:

                if locator.count() == 0:

                    continue

                self.executor.execute(

                    locator,

                    lambda l: l.click()

                )

                return True

            except Exception:

                continue

        return False

    def next_page(self):

        return self._click(

            self.NEXT_SELECTORS

        )

    def previous_page(self):

        return self._click(

            self.PREVIOUS_SELECTORS

        )