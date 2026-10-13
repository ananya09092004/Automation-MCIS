from dataclasses import dataclass

@dataclass
class ParsedGoal:

    intent: str

    target: str

    value: str = ""

    url: str = ""


class GoalParser:

    def parse(

        self,

        goal: str

    ) -> ParsedGoal:

        text = goal.lower()

        # -------- LOGIN --------

        if "login" in text or "sign in" in text:

            return ParsedGoal(

                intent="login",

                target="website"

            )

        # -------- SEARCH --------

        if "search" in text:

            query = text.replace(

                "search",

                ""

            ).strip()

            return ParsedGoal(

                intent="search",

                target="search_box",

                value=query

            )

        # -------- BUY --------

        if "buy" in text:

            item = text.replace(

                "buy",

                ""

            ).strip()

            return ParsedGoal(

                intent="shopping",

                target="product",

                value=item

            )

        # -------- OPEN --------

        if "open" in text:

            app = text.replace(

                "open",

                ""

            ).strip()

            return ParsedGoal(

                intent="open",

                target=app

            )

        return ParsedGoal(

            intent="observe",

            target="page"
        )