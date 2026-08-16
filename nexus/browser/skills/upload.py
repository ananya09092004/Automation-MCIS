from pathlib import Path

from browser.elements import ElementFinder


class UploadSkill:

    FILE_SELECTORS = [

        'input[type="file"]',

    ]

    def __init__(

        self,

        page

    ):

        self.page = page

        self.finder = ElementFinder(page)

    def execute(

        self,

        file_path: str

    ) -> bool:

        file = Path(file_path)

        if not file.exists():

            return False

        for selector in self.FILE_SELECTORS:

            try:

                locator = self.finder.by_selector(

                    selector

                ).first

                if locator.count() == 0:

                    continue

                locator.set_input_files(

                    str(file.resolve())

                )

                return True

            except Exception:

                continue

        return False