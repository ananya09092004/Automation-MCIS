from perception.locator.models import UIElement


class Locator:

    def __init__(self):

        pass

    def find(self, ocr_items, target, minimum_confidence=0.65):

        target = target.lower().strip()

        matches = []

        for item in ocr_items:

            text = item.text.lower().strip()

            if target in text and item.confidence >= minimum_confidence:

                matches.append(

                    UIElement(

                        text=item.text,

                        confidence=item.confidence,

                        x1=item.x1,
                        y1=item.y1,
                        x2=item.x2,
                        y2=item.y2

                    )

                )

        matches.sort(

            key=lambda x: x.confidence,

            reverse=True

        )

        return matches

    def find_first(self, ocr_items, target, minimum_confidence=0.65):

        matches = self.find(

            ocr_items,

            target,
            minimum_confidence

        )

        if matches:

            return matches[0]

        return None
