from browser.actions import BrowserActions
from browser.elements.finder import ElementFinder
from browser.wait import BrowserWait
from browser.verifier import BrowserVerifier


class BrowserWorkflowExecutor:

    def __init__(self, controller):

        self.controller = controller

        self.page = controller.page

        self.actions = BrowserActions()

        self.finder = ElementFinder(self.page)

        self.wait = BrowserWait(self.page)

        self.verify = BrowserVerifier(self.page)

    def run(self, workflow):

        results = []

        for step in workflow:

            action = step["action"]

            if action == "goto":

                self.controller.open(step["url"])

                results.append(True)

            elif action == "click":

                locator = self.finder.by_selector(
                    step["selector"]
                )

                results.append(
                    self.actions.click(locator)
                )

            elif action == "fill":

                locator = self.finder.by_selector(
                    step["selector"]
                )

                results.append(
                    self.actions.fill(
                        locator,
                        step["text"]
                    )
                )

            elif action == "type":

                locator = self.finder.by_selector(
                    step["selector"]
                )

                results.append(
                    self.actions.type(
                        locator,
                        step["text"]
                    )
                )

            elif action == "press":

                locator = self.finder.by_selector(
                    step["selector"]
                )

                results.append(
                    self.actions.press(
                        locator,
                        step["key"]
                    )
                )

            elif action == "wait":

                self.wait.seconds(
                    step["seconds"]
                )

                results.append(True)

            elif action == "verify_title":

                results.append(
                    self.verify.title_contains(
                        step["text"]
                    )
                )

            elif action == "verify_url":

                results.append(
                    self.verify.url_contains(
                        step["text"]
                    )
                )

            else:

                results.append(False)

        return results