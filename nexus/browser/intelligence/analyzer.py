from browser.intelligence.models import ElementInfo


class ElementAnalyzer:

    def __init__(self, page):

        self.page = page

    # ============================================================
    # Safe helpers
    # ============================================================

    def _safe_attr(self, locator, name):

        try:
            return locator.get_attribute(name) or ""
        except Exception:
            return ""

    def _safe_text(self, locator):

        try:
            return (
                locator.inner_text()
                or ""
            ).strip()

        except Exception:

            try:
                return (
                    locator.text_content()
                    or ""
                ).strip()

            except Exception:
                return ""

    def _safe_visible(self, locator):

        try:
            return locator.is_visible()
        except Exception:
            return False

    def _safe_enabled(self, locator):

        try:
            return locator.is_enabled()
        except Exception:
            return False

    def _safe_checked(self, locator):

        try:
            return locator.is_checked()
        except Exception:
            return False

    def _safe_box(self, locator):

        try:

            box = locator.bounding_box()

            if box:
                return box

        except Exception:
            pass

        return {
            "x": 0,
            "y": 0,
            "width": 0,
            "height": 0
        }

    def _safe_parent_info(self, locator):

        parent_tag = ""
        parent_role = ""

        try:

            parent = locator.locator("xpath=..")

            try:

                parent_tag = (
                    parent.evaluate(
                        "e => e.tagName.toLowerCase()"
                    )
                    or ""
                )

            except Exception:
                pass

            try:

                parent_role = (
                    parent.get_attribute("role")
                    or ""
                )

            except Exception:
                pass

        except Exception:
            pass

        return parent_tag, parent_role

    # ============================================================
    # Element extraction
    # ============================================================

    def _extract_element(

        self,
        locator,
        tag=None

    ):

        try:

            if tag is None:

                try:

                    tag = locator.evaluate(
                        "e => e.tagName.toLowerCase()"
                    )

                except Exception:

                    tag = ""

            box = self._safe_box(locator)

            parent_tag, parent_role = (
                self._safe_parent_info(locator)
            )

            input_type = self._safe_attr(
                locator,
                "type"
            ).lower()

            role = self._safe_attr(
                locator,
                "role"
            )

            placeholder = self._safe_attr(
                locator,
                "placeholder"
            )

            aria_label = self._safe_attr(
                locator,
                "aria-label"
            )

            name = self._safe_attr(
                locator,
                "name"
            )

            element_id = self._safe_attr(
                locator,
                "id"
            )

            css_class = self._safe_attr(
                locator,
                "class"
            )

            title = self._safe_attr(
                locator,
                "title"
            )

            href = self._safe_attr(
                locator,
                "href"
            )

            value = self._safe_attr(
                locator,
                "value"
            )

            autocomplete = self._safe_attr(
                locator,
                "autocomplete"
            )

            text = self._safe_text(
                locator
            )

            visible = self._safe_visible(
                locator
            )

            enabled = self._safe_enabled(
                locator
            )

            # ----------------------------------------------------
            # Element behavior
            # ----------------------------------------------------

            clickable = (

                tag in (
                    "button",
                    "a"
                )

                or input_type in (
                    "submit",
                    "button",
                    "checkbox",
                    "radio",
                    "image"
                )

                or role == "button"

                or self._safe_attr(
                    locator,
                    "onclick"
                )

            )

            editable = (

                tag in (
                    "input",
                    "textarea"
                )

                and input_type not in (
                    "hidden",
                    "button",
                    "submit",
                    "reset",
                    "checkbox",
                    "radio",
                    "file"
                )

            ) or (

                tag == "textarea"

            ) or (

                self._safe_attr(
                    locator,
                    "contenteditable"
                ).lower() == "true"

            )

            checked = False

            if input_type in (
                "checkbox",
                "radio"
            ):

                checked = self._safe_checked(
                    locator
                )

            # ----------------------------------------------------
            # Build ElementInfo
            #
            # Only use fields that already exist in your model.
            # ----------------------------------------------------

            return ElementInfo(

                tag=tag,

                text=text,

                role=role,

                input_type=input_type,

                placeholder=placeholder,

                enabled=enabled,

                visible=visible,

                href=href,

                aria_label=aria_label,

                name=name,

                value=value,

                element_id=element_id,

                css_class=css_class,

                title=title,

                checked=checked,

                x=box.get(
                    "x",
                    0
                ),

                y=box.get(
                    "y",
                    0
                ),

                width=box.get(
                    "width",
                    0
                ),

                height=box.get(
                    "height",
                    0
                ),

                parent_tag=parent_tag,

                parent_role=parent_role,

                clickable=clickable,

                editable=editable

            )

        except Exception as error:

            print(
                "ELEMENT ANALYSIS ERROR:",
                error
            )

            return None

    # ============================================================
    # Inputs
    # ============================================================

    def analyze_inputs(self):

        elements = []

        try:

            locators = self.page.locator(
                "input"
            ).all()

        except Exception:

            return elements

        for locator in locators:

            info = self._extract_element(
                locator,
                "input"
            )

            if info:

                elements.append(
                    info
                )

        return elements

    # ============================================================
    # Buttons
    # ============================================================

    def analyze_buttons(self):

        elements = []

        selector = (
            "button,"
            "input[type=submit],"
            "input[type=button],"
            "input[type=reset],"
            '[role="button"]'
        )

        try:

            locators = self.page.locator(
                selector
            ).all()

        except Exception:

            return elements

        for locator in locators:

            info = self._extract_element(
                locator
            )

            if info:

                elements.append(
                    info
                )

        return elements

    # ============================================================
    # Links
    # ============================================================

    def analyze_links(self):

        elements = []

        try:

            locators = self.page.locator(
                "a"
            ).all()

        except Exception:

            return elements

        for locator in locators:

            info = self._extract_element(
                locator,
                "a"
            )

            if info:

                elements.append(
                    info
                )

        return elements

    # ============================================================
    # Forms
    # ============================================================

    def analyze_forms(self):

        try:

            return self.page.locator(
                "form"
            ).count()

        except Exception:

            return 0

    # ============================================================
    # Tables
    # ============================================================

    def analyze_tables(self):

        tables = []

        try:

            locators = self.page.locator(
                "table"
            ).all()

        except Exception:

            return tables

        for table in locators:

            try:

                rows = table.locator(
                    "tr"
                ).count()

                cols = 0

                if rows:

                    cols = (
                        table
                        .locator("tr")
                        .first
                        .locator("th,td")
                        .count()
                    )

                tables.append(

                    ElementInfo(

                        tag="table",

                        text="",

                        role=(
                            self._safe_attr(
                                table,
                                "role"
                            )
                        ),

                        input_type="",

                        placeholder="",

                        enabled=True,

                        visible=(
                            self._safe_visible(
                                table
                            )
                        ),

                        rows=rows,

                        columns=cols

                    )

                )

            except Exception:
                pass

        return tables

    # ============================================================
    # Uploads
    # ============================================================

    def analyze_uploads(self):

        uploads = []

        try:

            locators = self.page.locator(
                'input[type="file"]'
            ).all()

        except Exception:

            return uploads

        for locator in locators:

            info = self._extract_element(
                locator,
                "input"
            )

            if info:

                uploads.append(
                    info
                )

        return uploads

    # ============================================================
    # Dialogs / Popups
    # ============================================================

    def analyze_dialogs(self):

        dialogs = []

        selectors = [

            '[role="dialog"]',

            '[aria-modal="true"]',

            "dialog"

        ]

        for selector in selectors:

            try:

                locators = self.page.locator(
                    selector
                ).all()

            except Exception:

                continue

            for locator in locators:

                try:

                    dialogs.append(

                        ElementInfo(

                            tag="dialog",

                            text=(
                                self._safe_text(
                                    locator
                                )[:300]
                            ),

                            role=(
                                self._safe_attr(
                                    locator,
                                    "role"
                                )
                                or "dialog"
                            ),

                            input_type="",

                            placeholder="",

                            enabled=True,

                            visible=(
                                self._safe_visible(
                                    locator
                                )
                            )

                        )

                    )

                except Exception:
                    pass

        return dialogs

    # ============================================================
    # Navigation
    # ============================================================

    def analyze_navigation(self):

        try:

            return {

                "url": self.page.url,

                "title": self.page.title(),

                "back_available": False,

                "forward_available": False,

                "links": (
                    self.page
                    .locator("a")
                    .count()
                ),

                "forms": (
                    self.page
                    .locator("form")
                    .count()
                ),

                "buttons": (
                    self.page
                    .locator(
                        "button,"
                        "input[type=submit],"
                        "input[type=button]"
                    )
                    .count()
                ),

                "inputs": (
                    self.page
                    .locator("input")
                    .count()
                )

            }

        except Exception:

            return {

                "url": "",

                "title": "",

                "back_available": False,

                "forward_available": False,

                "links": 0,

                "forms": 0,

                "buttons": 0,

                "inputs": 0

            }

    # ============================================================
    # Textareas
    # ============================================================

    def analyze_textareas(self):

        elements = []

        try:

            locators = self.page.locator(
                "textarea"
            ).all()

        except Exception:

            return elements

        for locator in locators:

            info = self._extract_element(
                locator,
                "textarea"
            )

            if info:

                elements.append(
                    info
                )

        return elements

    # ============================================================
    # Selects
    # ============================================================

    def analyze_selects(self):

        elements = []

        try:

            locators = self.page.locator(
                "select"
            ).all()

        except Exception:

            return elements

        for locator in locators:

            info = self._extract_element(
                locator,
                "select"
            )

            if info:

                elements.append(
                    info
                )

        return elements

    # ============================================================
    # Checkboxes
    # ============================================================

    def analyze_checkboxes(self):

        elements = []

        try:

            locators = self.page.locator(
                'input[type="checkbox"]'
            ).all()

        except Exception:

            return elements

        for locator in locators:

            info = self._extract_element(
                locator,
                "input"
            )

            if info:

                elements.append(
                    info
                )

        return elements

    # ============================================================
    # Radio buttons
    # ============================================================

    def analyze_radios(self):

        elements = []

        try:

            locators = self.page.locator(
                'input[type="radio"]'
            ).all()

        except Exception:

            return elements

        for locator in locators:

            info = self._extract_element(
                locator,
                "input"
            )

            if info:

                elements.append(
                    info
                )

        return elements

    # ============================================================
    # Contenteditable
    # ============================================================

    def analyze_editable(self):

        elements = []

        try:

            locators = self.page.locator(
                '[contenteditable="true"]'
            ).all()

        except Exception:

            return elements

        for locator in locators:

            info = self._extract_element(
                locator
            )

            if info:

                elements.append(
                    info
                )

        return elements

    # ============================================================
    # Images
    # ============================================================

    def analyze_images(self):

        elements = []

        try:

            locators = self.page.locator(
                "img"
            ).all()

        except Exception:

            return elements

        for locator in locators:

            info = self._extract_element(
                locator,
                "img"
            )

            if info:

                elements.append(
                    info
                )

        return elements

    # ============================================================
    # SVG
    # ============================================================

    def analyze_svgs(self):

        elements = []

        try:

            locators = self.page.locator(
                "svg"
            ).all()

        except Exception:

            return elements

        for locator in locators:

            info = self._extract_element(
                locator,
                "svg"
            )

            if info:

                elements.append(
                    info
                )

        return elements

    # ============================================================
    # Generic clickable elements
    # ============================================================

    def analyze_clickables(self):

        selectors = [

            "button",

            "a",

            '[role="button"]',

            '[onclick]',

            '[tabindex]',

            "summary"

        ]

        elements = []

        for selector in selectors:

            try:

                locators = self.page.locator(
                    selector
                ).all()

            except Exception:

                continue

            for locator in locators:

                info = self._extract_element(
                    locator
                )

                if info:

                    elements.append(
                        info
                    )

        return elements

    # ============================================================
    # Page semantics
    # ============================================================

    def analyze_page_semantics(self):

        try:

            text = (
                self.page
                .locator("body")
                .inner_text()
                .lower()
            )

        except Exception:

            text = ""

        result = {

            "login": False,

            "search": False,

            "shopping": False,

            "article": False,

            "checkout": False,

            "dashboard": False

        }

        if "password" in text:

            result["login"] = True

        if "sign in" in text:

            result["login"] = True

        if "login" in text:

            result["login"] = True

        if "search" in text:

            result["search"] = True

        if (
            "cart" in text
            or "buy" in text
        ):

            result["shopping"] = True

        if "checkout" in text:

            result["checkout"] = True

        if "dashboard" in text:

            result["dashboard"] = True

        try:

            if self.page.locator(
                "article"
            ).count():

                result["article"] = True

        except Exception:
            pass

        return result