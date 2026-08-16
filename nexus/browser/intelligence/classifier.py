from dataclasses import dataclass

from browser.intelligence.page_features import PageFeatures


@dataclass
class PageType:

    category: str

    confidence: float


class PageClassifier:

    def classify(

        self,

        features: PageFeatures

    ) -> PageType:

        scores = {

            "login": 0,

            "secure": 0,

            "dashboard": 0,

            "search": 0,

            "shopping": 0,

            "checkout": 0,

            "booking": 0,

            "email": 0,

            "settings": 0,

            "article": 0,

            "documentation": 0,

            "chat": 0,

            "unknown": 0

        }

        text = features.text.lower()

        title = features.title.lower()

        url = features.url.lower()


        # ---------------- LOGIN ----------------

        # Strong negative signal:
        # A secure/authenticated URL should never be classified
        # as a login page just because a password input exists
        # somewhere in the DOM.

        authenticated_url_words = [
            "/secure",
            "/dashboard",
            "/account",
            "/profile",
            "/home"
        ]

        authenticated_url = any(
            word in url
            for word in authenticated_url_words
        )

        if authenticated_url:
            scores["dashboard"] += 100

        else:

            if features.password_inputs:
                scores["login"] += 100

            if features.forms:
                scores["login"] += 20

            if "login" in url:
                scores["login"] += 60

            if "signin" in url:
                scores["login"] += 60

            if "login" in title:
                scores["login"] += 40

            if "sign in" in text:
                scores["login"] += 30

        # ---------------- SEARCH ----------------

        if features.search_inputs:

            scores["search"] += 100

        if "search" in title:

            scores["search"] += 30

        if "search" in text:

            scores["search"] += 20

        # ---------------- DASHBOARD ----------------

        dashboard_words = [

            "dashboard",

            "overview",

            "analytics",

            "repositories",

            "workspace",

            "projects",

            "activity"

        ]

        for word in dashboard_words:

            if word in text:

                scores["dashboard"] += 15

        # ---------------- SHOPPING ----------------

        shopping_words = [

            "cart",

            "wishlist",

            "buy",

            "price",

            "add to cart",

            "quantity"

        ]

        for word in shopping_words:

            if word in text:

                scores["shopping"] += 15

        # ---------------- CHECKOUT ----------------

        checkout_words = [

            "checkout",

            "billing",

            "shipping",

            "payment",

            "place order"

        ]

        for word in checkout_words:

            if word in text:

                scores["checkout"] += 20

        # ---------------- EMAIL ----------------

        email_words = [

            "compose",

            "inbox",

            "draft",

            "reply",

            "forward"

        ]

        for word in email_words:

            if word in text:

                scores["email"] += 20

        # ---------------- SETTINGS ----------------

        settings_words = [

            "settings",

            "preferences",

            "privacy",

            "security",

            "account"

        ]

        for word in settings_words:

            if word in text:

                scores["settings"] += 20

        # ---------------- DOCS ----------------

        docs_words = [

            "documentation",

            "api",

            "reference",

            "installation",

            "guide"

        ]

        for word in docs_words:

            if word in text:

                scores["documentation"] += 20

        # ---------------- ARTICLE ----------------

        if features.headings >= 3:

            scores["article"] += 10

        article_words = [

            "author",

            "published",

            "read more"

        ]

        for word in article_words:

            if word in text:

                scores["article"] += 20

        # ---------------- CHAT ----------------

        chat_words = [

            "message",

            "conversation",

            "typing",

            "chat"

        ]

        for word in chat_words:

            if word in text:

                scores["chat"] += 20

        best = max(

            scores,

            key=scores.get

        )

        best_score = scores[best]

        if best_score == 0:

            return PageType(

                category="unknown",

                confidence=0.0

            )

        confidence = min(

            best_score / 100,

            1.0

        )

        return PageType(

            category=best,

            confidence=round(

                confidence,

                2

            )

        )