from browser.skills import (

    SearchSkill,

    LoginSkill,

    FormFillSkill,

    UploadSkill,

    DownloadSkill,

    NavigationSkill,

    PaginationSkill,

    PopupSkill,

    TableReaderSkill,

    InfiniteScrollSkill

)


class WorkflowEngine:

    def __init__(

        self,

        page

    ):

        self.page = page

        self.navigation = NavigationSkill(page)

        self.search = SearchSkill(page)

        self.login = LoginSkill(page)

        self.form = FormFillSkill(page)

        self.upload = UploadSkill(page)

        self.download = DownloadSkill(page)

        self.pagination = PaginationSkill(page)

        self.popup = PopupSkill(page)

        self.table = TableReaderSkill(page)

        self.scroll = InfiniteScrollSkill(page)

    def execute(

        self,

        workflow

    ):

        results = []

        for step in workflow:

            action = step["action"]

            if action == "goto":

                results.append(

                    self.navigation.goto(

                        step["url"]

                    )

                )

            elif action == "search":

                results.append(

                    self.search.execute(

                        step["query"]

                    )

                )

            elif action == "login":

                results.append(

                    self.login.execute(

                        step["username"],

                        step["password"]

                    )

                )

            elif action == "fill":

                # Old workflow format
                if "values" in step:

                    results.append(

                        self.form.execute(

                            step["values"]

                        )

                    )

                # New autonomous workflow format
                else:

                    results.append(

                        self.form.execute(

                            {

                                step["target"]: step.get(

                                    "value",

                                    ""

                                )

                            }

                        )

                    )

            elif action == "upload":

                results.append(

                    self.upload.execute(

                        step["path"]

                    )

                )

            elif action == "next_page":

                results.append(

                    self.pagination.next_page()

                )

            elif action == "close_popup":

                results.append(

                    self.popup.close()

                )

            elif action == "read_table":

                results.append(

                    self.table.read()

                )

            elif action == "scroll":

                results.append(

                    self.scroll.scroll()

                )

        return results