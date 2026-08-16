from browser.intelligence.page_features import PageFeatures


class PageFeatureExtractor:

    def __init__(self, page):

        self.page = page

    def extract(self):

        body = self.page.locator("body")

        try:
            text = body.inner_text()
        except Exception:
            text = ""

        url = self.page.url

        title = self.page.title()

        forms = self.page.locator("form").count()

        buttons = self.page.locator(
            "button,input[type=submit],input[type=button]"
        ).count()

        links = self.page.locator("a").count()

        inputs = self.page.locator("input").count()

        password_inputs = self.page.locator(
            'input[type="password"]'
        ).count()

        search_inputs = self.page.locator(
            'input[type="search"],input[name="q"],textarea[name="q"]'
        ).count()

        file_inputs = self.page.locator(
            'input[type="file"]'
        ).count()

        tables = self.page.locator("table").count()

        dialogs = self.page.locator(
            '[role="dialog"],dialog,[aria-modal="true"]'
        ).count()

        headings = self.page.locator(
            "h1,h2,h3,h4,h5,h6"
        ).count()

        interactive = (

            buttons

            + links

            + inputs

        )

        return PageFeatures(

            url=url,

            title=title,

            text=text,

            forms=forms,

            buttons=buttons,

            links=links,

            inputs=inputs,

            password_inputs=password_inputs,

            search_inputs=search_inputs,

            file_inputs=file_inputs,

            tables=tables,

            dialogs=dialogs,

            headings=headings,

            interactive_elements=interactive

        )