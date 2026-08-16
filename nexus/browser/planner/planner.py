from browser.models import BrowserAction


class BrowserPlanner:

    def plan(

        self,

        command: str

    ):

        command = command.lower()

        workflow = []

        # --------------------
        # Google
        # --------------------

        if "google" in command:

            workflow.append(

                BrowserAction(

                    action="goto",

                    url="https://google.com"

                )

            )

        # --------------------
        # Search
        # --------------------

        if "search" in command:

            text = command.split("search")[-1].strip()

            workflow.extend(

                [

                    BrowserAction(

                        action="fill",

                        selector='textarea[name="q"]',

                        text=text

                    ),

                    BrowserAction(

                        action="press",

                        selector='textarea[name="q"]',

                        key="Enter"

                    )

                ]

            )

        return workflow