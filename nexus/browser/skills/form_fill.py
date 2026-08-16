from browser.actions import BrowserActions


class FormFillSkill:

    def __init__(

        self,

        page

    ):

        self.page = page

        self.actions = BrowserActions()

    def execute(

        self,

        values: dict

    ) -> bool:

        inputs = self.page.locator(

            "input, textarea, select"

        )

        count = inputs.count()

        for i in range(count):

            field = inputs.nth(i)

            try:

                if not field.is_visible():

                    continue

                if not field.is_enabled():

                    continue

                field_type = (

                    field.get_attribute("type")

                    or ""

                ).lower()

                if field_type in (

                    "hidden",

                    "submit",

                    "button",

                    "image",

                    "reset",

                    "file"

                ):

                    continue

                key = None

                for attr in (

                    "name",

                    "id",

                    "placeholder",

                    "aria-label"

                ):

                    value = field.get_attribute(attr)

                    if value:

                        key = value.lower()

                        break

                if not key:

                    continue

                for data_key, data_value in values.items():

                    if data_key.lower() in key:

                        tag = field.evaluate(

                            "e => e.tagName.toLowerCase()"

                        )

                        if tag == "select":

                            field.select_option(

                                str(data_value)

                            )

                        else:

                            self.actions.fill(

                                field,

                                str(data_value)

                            )

                        break

            except Exception:

                continue

        return True