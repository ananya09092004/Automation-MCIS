from browser.elements import ElementFinder
from browser.actions import BrowserActions


class LoginSkill:

    USER_SELECTORS = [

        'input[type="email"]',
        'input[name="email"]',
        'input[name="username"]',
        'input[autocomplete="username"]',
        'input[type="text"]'

    ]

    PASSWORD_SELECTORS = [

        'input[type="password"]',
        'input[autocomplete="current-password"]'

    ]

    SUBMIT_SELECTORS = [

        'button[type="submit"]',
        'input[type="submit"]',
        'button'

    ]

    def __init__(self, page):

        self.page = page
        self.finder = ElementFinder(page)
        self.actions = BrowserActions()

    def _find_first(self, selectors):

        for selector in selectors:

            try:

                locator = self.finder.by_selector(selector).first

                if locator.count() == 0:
                    continue

                if not locator.is_visible():
                    continue

                return locator

            except Exception:
                continue

        return None

    def execute(

        self,

        username,

        password

    ) -> bool:

        user = self._find_first(

            self.USER_SELECTORS

        )

        pwd = self._find_first(

            self.PASSWORD_SELECTORS

        )

        submit = self._find_first(

            self.SUBMIT_SELECTORS

        )

        if user is None or pwd is None:

            return False

        self.actions.fill(

            user,

            username

        )

        self.actions.fill(

            pwd,

            password

        )

        if submit:

            self.actions.click(submit)

        else:

            self.actions.press(

                pwd,

                "Enter"

            )

        return True