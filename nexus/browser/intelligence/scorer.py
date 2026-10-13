from browser.intelligence.models import ElementInfo


class SemanticScorer:

    ACTION_KEYWORDS = {

        "username": [
            "user",
            "username",
            "email",
            "login",
            "signin"
        ],

        "password": [
            "password",
            "pass",
            "pwd"
        ],

        "search": [
            "search",
            "find",
            "lookup",
            "query",
            "filter"
        ],

        "login_button": [
            "login",
            "log in",
            "sign in",
            "signin",
            "continue",
            "submit"
        ],

        "next": [
            "next",
            "continue",
            "proceed",
            "forward",
            "more",
            ">"
        ],

        "previous": [
            "previous",
            "back",
            "return",
            "<"
        ],

        "submit": [
            "submit",
            "finish",
            "done",
            "confirm",
            "save",
            "apply"
        ],

        "cancel": [
            "cancel",
            "close",
            "dismiss"
        ],

        "download": [
            "download",
            "export",
            "save"
        ],

        "upload": [
            "upload",
            "browse",
            "choose file",
            "select file"
        ]
    }

    def score(

        self,

        target: str,

        element: ElementInfo

    ) -> int:

        target = target.lower()

        score = 0

        # Ignore useless elements

        if not element.visible:
            return -1000

        if not element.enabled:
            return -500

        if element.input_type == "hidden":
            return -1000

        text = " ".join([

            element.tag,

            element.input_type,

            element.name,

            element.element_id,

            element.placeholder,

            element.aria_label,

            element.text,

            getattr(element, "href", ""),

            getattr(element, "css_class", "")

        ]).lower()

        # ---------- Semantic keyword scoring ----------

        if target in self.ACTION_KEYWORDS:

            for keyword in self.ACTION_KEYWORDS[target]:

                if keyword in text:

                    score += 100

        # ---------- Generic bonuses ----------

        if element.tag == "button":
            score += 40

        if element.tag == "a":
            score += 20

        if element.tag == "input":
            score += 20

        # ---------- Specialized bonuses ----------

        if (

            target == "username"

            and

            element.input_type in (

                "text",

                "email"

            )

        ):

            score += 200

        if (

            target == "password"

            and

            element.input_type == "password"

        ):

            score += 600

        if (

            target == "search"

            and

            element.input_type == "search"

        ):

            score += 600

        if (

            target == "upload"

            and

            element.input_type == "file"

        ):

            score += 700

        if (

            target in (

                "submit",

                "login_button"

            )

            and

            element.input_type == "submit"

        ):

            score += 500

        # Primary submit buttons ko priority
        if target == "login_button":

            classes = getattr(element, "css_class", "").lower()

            if "primary" in classes:
                score += 400

            if "secondary" in classes:
                score -= 300

            if "passkey" in classes:
                score -= 1000

            if "webauthn" in classes:
                score -= 1000

            text = element.text.lower()

            if "passkey" in text:
                score -= 1000

            if "sign in with" in text:
                score -= 500

            if "continue with" in text:
                score -= 500


        if (

            target == "login_button"

            and

            element.tag == "button"

        ):

            score += 300

        return score