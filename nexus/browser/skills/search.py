from browser.elements import ElementFinder
from browser.actions import BrowserActions
from browser.intelligence.analyzer import ElementAnalyzer
from browser.intelligence.element_matcher import ElementMatcher

class SearchSkill:

    SEARCH_SELECTORS = [

        'input[type="search"]',

        'input[name="q"]',

        'textarea[name="q"]',

        'input[placeholder*="Search" i]',

        'input[aria-label*="Search" i]',

        'input[type="text"]'

    ]

    def __init__(

        self,

        page

    ):

        self.page = page

        self.finder = ElementFinder(page)

        self.actions = BrowserActions()

        self.analyzer = ElementAnalyzer(page)
        self.matcher = ElementMatcher()

    def execute(

        self,

        query: str

    ) -> bool:

        elements = self.analyzer.analyze_inputs()

        best = self.matcher.match(
            "search",
            elements
        )

        if best is None:
            return False

        locator = self.finder.from_element(best)

        if locator is None:
            return False

        self.actions.fill(locator, query)
        self.actions.press(locator, "Enter")

        return True