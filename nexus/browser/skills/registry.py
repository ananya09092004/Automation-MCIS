from browser.skills.login import LoginSkill
from browser.skills.search import SearchSkill
from browser.skills.navigation import NavigationSkill
from browser.skills.upload import UploadSkill
from browser.skills.download import DownloadSkill
from browser.skills.pagination import PaginationSkill
from browser.skills.popup import PopupSkill
from browser.skills.infinite_scroll import InfiniteScrollSkill
from browser.skills.table_reader import TableReaderSkill


class SkillRegistry:

    def __init__(

        self,

        page

    ):

        self.skills = {

            "LoginSkill": LoginSkill(page),

            "SearchSkill": SearchSkill(page),

            "NavigationSkill": NavigationSkill(page),

            "UploadSkill": UploadSkill(page),

            "DownloadSkill": DownloadSkill(page),

            "PaginationSkill": PaginationSkill(page),

            "PopupSkill": PopupSkill(page),

            "InfiniteScrollSkill": InfiniteScrollSkill(page),

            "TableReaderSkill": TableReaderSkill(page)

        }

    def get(

        self,

        name

    ):

        return self.skills.get(name)