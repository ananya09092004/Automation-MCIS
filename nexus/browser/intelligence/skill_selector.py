from dataclasses import dataclass


@dataclass
class SelectedSkill:

    name: str

    confidence: float


class SkillSelector:

    def select(

        self,

        goal: str,

        page_type: str,

        observations: dict

    ) -> SelectedSkill:

        goal = goal.lower()

        page_type = page_type.lower()

        text = goal

        # -----------------------
        # LOGIN
        # -----------------------

        if page_type == "login":

            return SelectedSkill(

                "LoginSkill",

                1.0

            )

        # -----------------------
        # SEARCH
        # -----------------------

        if (

            "search" in text

            or

            "find" in text

            or

            page_type == "search"

        ):

            return SelectedSkill(

                "SearchSkill",

                0.95

            )

        # -----------------------
        # DOWNLOAD
        # -----------------------

        if (

            "download" in text

        ):

            return SelectedSkill(

                "DownloadSkill",

                0.95

            )

        # -----------------------
        # UPLOAD
        # -----------------------

        if (

            "upload" in text

        ):

            return SelectedSkill(

                "UploadSkill",

                0.95

            )

        # -----------------------
        # TABLE
        # -----------------------

        if (

            observations.get(

                "tables",

                0

            )

            >

            0

        ):

            return SelectedSkill(

                "TableReaderSkill",

                0.90

            )

        # -----------------------
        # POPUP
        # -----------------------

        if observations.get(

            "dialog"

        ):

            return SelectedSkill(

                "PopupSkill",

                0.90

            )

        # -----------------------
        # INFINITE SCROLL
        # -----------------------

        if observations.get(

            "scrollable"

        ):

            return SelectedSkill(

                "InfiniteScrollSkill",

                0.90

            )

        # -----------------------
        # PAGINATION
        # -----------------------

        if observations.get(

            "pagination"

        ):

            return SelectedSkill(

                "PaginationSkill",

                0.90

            )

        # -----------------------
        # DEFAULT
        # -----------------------

        return SelectedSkill(

            "NavigationSkill",

            0.50

        )