class TableReaderSkill:

    def __init__(

        self,

        page

    ):

        self.page = page

    def read(self):

        tables = self.page.locator("table")

        result = []

        for t in range(tables.count()):

            table = tables.nth(t)

            rows = table.locator("tr")

            table_data = []

            for r in range(rows.count()):

                cols = rows.nth(r).locator("th, td")

                row = []

                for c in range(cols.count()):

                    row.append(

                        cols.nth(c).inner_text().strip()

                    )

                if row:

                    table_data.append(row)

            result.append(table_data)

        return result