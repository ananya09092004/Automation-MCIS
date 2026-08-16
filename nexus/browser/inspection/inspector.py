from .models import PageAnalysis


class WebsiteInspector:

    def __init__(self, page):

        self.page = page

    def analyze(self) -> PageAnalysis:

        return PageAnalysis(

            title=self.page.title(),

            url=self.page.url,

            buttons=self.page.locator("button").count(),

            inputs=self.page.locator("input").count(),

            textareas=self.page.locator("textarea").count(),

            dropdowns=self.page.locator("select").count(),

            links=self.page.locator("a").count(),

            forms=self.page.locator("form").count(),

            images=self.page.locator("img").count()

        )