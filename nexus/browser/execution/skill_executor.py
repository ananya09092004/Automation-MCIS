from browser.skills.search import SearchSkill
from browser.skills.navigation import NavigationSkill
from browser.skills.login import LoginSkill
from browser.skills.form_fill import FormFillSkill
from browser.skills.upload import UploadSkill
from browser.skills.download import DownloadSkill
from browser.skills.pagination import PaginationSkill
from browser.skills.infinite_scroll import InfiniteScrollSkill
from browser.skills.popup import PopupSkill
from browser.skills.table_reader import TableReaderSkill


class SkillExecutor:

    def __init__(

        self,

        page

    ):

        self.skills = {

            "search": SearchSkill(page),

            "navigate": NavigationSkill(page),

            "login": LoginSkill(page),

            "form_fill": FormFillSkill(page),

            "upload": UploadSkill(page),

            "download": DownloadSkill(page),

            "pagination": PaginationSkill(page),

            "scroll": InfiniteScrollSkill(page),

            "popup": PopupSkill(page),

            "table": TableReaderSkill(page)

        }

    def execute(

        self,

        skill_name,

        *args,

        **kwargs

    ):

        skill = self.skills.get(skill_name)

        if skill is None:

            return False

        return skill.execute(

            *args,

            **kwargs

        )

    def register(

        self,

        name,

        skill

    ):

        self.skills[name] = skill