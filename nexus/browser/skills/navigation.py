from browser.elements import ElementFinder
from browser.actions import BrowserActions

from browser.intelligence.analyzer import ElementAnalyzer
from browser.intelligence.element_matcher import ElementMatcher

class NavigationSkill:

    def __init__(

        self,

        page

    ):

        self.page = page

        self.finder = ElementFinder(page)

        self.actions = BrowserActions()

        self.analyzer = ElementAnalyzer(page)

        self.matcher = ElementMatcher()

    def goto(

        self,

        url: str

    ):

        self.page.goto(

            url

        )

        return True

    def back(self):

        self.page.go_back()

        return True

    def forward(self):

        self.page.go_forward()

        return True

    def refresh(self):

        self.page.reload()

        return True

    def click_navigation(

        self,

        target: str = "next"

    ):

        elements = (

            self.analyzer.analyze_buttons()

            +

            self.analyzer.analyze_links()

        )

        best = self.matcher.match(

            target,

            elements

        )

        if best is None:

            return False

        locator = self.finder.from_element(

            best

        )

        if locator is None:

            return False

        self.actions.click(

            locator

        )

        return True

    def current_url(self):

        return self.page.url

    def title(self):

        return self.page.title()

    def wait(self):

        self.page.wait_for_load_state(

            "networkidle"

        )

        return True