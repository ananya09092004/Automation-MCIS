from playwright.sync_api import TimeoutError


class SafeExecutor:

    def __init__(

        self,

        page,

        retries=3

    ):

        self.page = page

        self.retries = retries

    def execute(

        self,

        locator,

        action,

        *args,

        **kwargs

    ):

        last_error = None

        for _ in range(self.retries):

            try:

                locator.wait_for(

                    state="visible",

                    timeout=5000

                )

                locator.scroll_into_view_if_needed()

                locator.wait_for(

                    state="attached"

                )

                result = action(

                    locator,

                    *args,

                    **kwargs

                )

                self.page.wait_for_load_state(

                    "networkidle"

                )

                return result

            except TimeoutError as e:

                last_error = e

                continue

            except Exception as e:

                last_error = e

                continue

        raise last_error