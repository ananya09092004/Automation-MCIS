from pathlib import Path


class DownloadSkill:

    def __init__(

        self,

        page

    ):

        self.page = page

    def execute(

        self,

        locator,

        save_directory="browser/downloads"

    ) -> str | None:

        Path(

            save_directory

        ).mkdir(

            parents=True,

            exist_ok=True

        )

        if locator.count() == 0:
            return None

        if not locator.is_visible():
            return None

        locator.scroll_into_view_if_needed()

        with self.page.expect_download() as download_info:

            locator.click()

        download = download_info.value

        path = Path(

            save_directory

        ) / download.suggested_filename

        download.save_as(

            str(path)

        )

        return str(path)