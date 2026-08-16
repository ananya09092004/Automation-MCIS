from browser.inspection.inspector import WebsiteInspector

from browser.intelligence.classifier import PageClassifier
from browser.intelligence.page_feature_extractor import (
    PageFeatureExtractor,
)


class WorldUpdater:

    def __init__(

        self,

        page,

        world_manager

    ):

        self.page = page

        self.world = world_manager

        self.inspector = WebsiteInspector(page)

        self.classifier = PageClassifier()

        self.extractor = PageFeatureExtractor(page)

    def update(self):

        # Inspector (counts etc.)
        analysis = self.inspector.analyze()

        # Rich page features
        features = self.extractor.extract()

        # Intelligent page classification
        page_type = self.classifier.classify(

            features

        )

        observations = {

            "buttons": analysis.buttons,

            "forms": analysis.forms,

            "inputs": analysis.inputs,

            "links": analysis.links,

            "images": analysis.images,

            "tables": features.tables,

            "dialogs": features.dialogs,

            "headings": features.headings,

            "password_inputs": features.password_inputs,

            "search_inputs": features.search_inputs,

            "file_inputs": features.file_inputs,

            "interactive": features.interactive_elements,

            "text_length": len(features.text),

            "has_forms": features.forms > 0,

            "has_inputs": features.inputs > 0,

            "has_buttons": features.buttons > 0,

            "has_links": features.links > 0,

            "loading": False,

            "dialog": features.dialogs > 0,

            "error": False,

        }

        # ---------------- LOADING ----------------

        try:

            observations["loading"] = (

                self.page.locator(

                    """
                    [aria-busy="true"],
                    .loading,
                    .spinner,
                    .loader,
                    .progress,
                    [role="progressbar"]
                    """

                ).count()

                > 0

            )

        except Exception:

            pass

        # ---------------- ERROR ----------------

        try:

            text = features.text.lower()

            error_words = [

                "error",

                "something went wrong",

                "try again",

                "failed",

                "404",

                "500",

                "forbidden",

                "access denied",

                "not found"

            ]

            observations["error"] = any(

                word in text

                for word in error_words

            )

        except Exception:

            pass

        self.world.update(

            current_url=features.url,

            page_title=features.title,

            page_type=page_type.category,

            observations=observations

        )

        return self.world.get()