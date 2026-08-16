from playwright.sync_api import Page


class ElementMatcher:

    def __init__(

        self,

        page: Page

    ):

        self.page = page

    def match(

        self,

        logical_target: str

    ):

        logical_target = logical_target.lower()

        if logical_target == "username":

            candidates = [

                'input[type="email"]',

                'input[type="text"]',

                'input[name*="email" i]',

                'input[name*="user" i]',

                'input[id*="email" i]',

                'input[id*="user" i]',

                'input[autocomplete="username"]',

                'input[autocomplete="email"]'

            ]

        elif logical_target == "password":

            candidates = [

                'input[type="password"]'

            ]

        elif logical_target == "search_box":

            candidates = [

                'input[type="search"]',

                'input[name="q"]',

                'textarea[name="q"]',

                'input[placeholder*="Search"]',

                'input[placeholder*="search"]'

            ]

        elif logical_target == "login_button":

            candidates = [

                'button[type="submit"]',

                'input[type="submit"]',

                'button'

            ]

        else:

            return None

        for selector in candidates:

            locator = self.page.locator(selector)

            if locator.count() > 0:

                for i in range(locator.count()):

                    element = locator.nth(i)

                    if element.is_visible():

                        return element

        return None