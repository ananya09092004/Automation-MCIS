import time


class InfiniteScrollSkill:

    def __init__(

        self,

        page

    ):

        self.page = page

    def scroll(

        self,

        max_scrolls=10,

        pause=1.0

    ):

        previous_height = 0

        for _ in range(max_scrolls):

            current_height = self.page.evaluate(

                "document.body.scrollHeight"

            )

            self.page.evaluate(

                "window.scrollTo(0, document.body.scrollHeight)"
            )

            time.sleep(pause)

            new_height = self.page.evaluate(

                "document.body.scrollHeight"

            )

            if new_height == previous_height:

                break

            previous_height = new_height

        return True