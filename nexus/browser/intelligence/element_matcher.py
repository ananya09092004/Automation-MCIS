from browser.intelligence.models import ElementInfo
from browser.intelligence.scorer import SemanticScorer


class ElementMatcher:

    MIN_SCORE = 100

    def __init__(self):

        self.scorer = SemanticScorer()

    def match(

        self,

        target: str,

        elements: list[ElementInfo]

    ):

        target = target.lower()

        candidates = []

        for element in elements:

            score = self.scorer.score(

                target,

                element

            )

            if score <= 0:

                continue

            candidates.append(

                (

                    score,

                    element

                )

            )

        if not candidates:

            return None

        candidates.sort(

            key=lambda x: x[0],

            reverse=True

        )

        best_score = candidates[0][0]

        best_element = candidates[0][1]

        # Score bahut kam hai
        if best_score < self.MIN_SCORE:

            return None

        # Agar top 2 almost same hain
        if len(candidates) > 1:

            second_score = candidates[1][0]

            if best_score - second_score < 30:

                print()

                print("MATCH WARNING")

                print(

                    f"Ambiguous match for '{target}'"

                )

                print(

                    "Top Score   :",

                    best_score

                )

                print(

                    "Second Score:",

                    second_score

                )

                print()

        print()

        print("MATCH SCORE")

        print(

            target,

            "->",

            best_score

        )

        print()

        return best_element