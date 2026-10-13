from browser.intelligence.execution_planner import ExecutionPlan
from browser.intelligence.matcher import ElementMatcher
from browser.actions import BrowserActions
from browser.execution.skill_executor import SkillExecutor

class ExecutionRuntime:

    def __init__(

        self,

        page,

        verifier=None,

        retry_engine=None,

        recovery_engine=None

    ):

        self.page = page

        self.matcher = ElementMatcher(page)

        self.actions = BrowserActions()

        self.verifier = verifier

        self.retry_engine = retry_engine

        self.skill_executor = SkillExecutor(page)

        self.recovery_engine = recovery_engine

        self.action_map = {

            "click": self._click,

            "fill": self._fill,

            "press": self._press,

            "scroll": self._scroll,

            "wait": self._wait,

            "navigate": self._navigate,

            "hover": self._hover,

            "upload": self._upload,

            "download": self._download,

            # Skills

            "search": self._search,

            "login": self._login,

            "pagination": self._pagination,

            "popup": self._popup,

            "table": self._table,

            "form_fill": self._form_fill

        }

    def execute(

        self,

        plan: ExecutionPlan,

        values=None

    ):

        if values is None:

            values = {}

        for step in plan.steps:

            action = step.action.action

            handler = self.action_map.get(action)

            if handler is None:

                return False

            ok = handler(

                step,

                values

            )

            if not ok:

                return False

            if self.verifier:

                verified = self.verifier.verify(step)

                if not verified:

                    return False

        return True

    def _locator(

        self,

        target

    ):

        return self.matcher.match(target)

    def _click(

        self,

        step,

        values

    ):

        locator = self._locator(step.action.target)

        if locator is None:

            return False

        self.actions.click(locator)

        return True

    def _fill(

        self,

        step,

        values

    ):

        locator = self._locator(step.action.target)

        if locator is None:

            return False

        value = values.get(

            step.action.target,

            step.action.value or ""

        )

        self.actions.fill(

            locator,

            value

        )

        return True

    def _press(

        self,

        step,

        values

    ):

        locator = self._locator(step.action.target)

        if locator is None:

            return False

        self.actions.press(

            locator,

            values.get(

                "key",

                "Enter"

            )

        )

        return True

    def _scroll(

        self,

        step,

        values

    ):

        self.page.mouse.wheel(

            0,

            values.get(

                "scroll",

                800

            )

        )

        return True

    def _wait(

        self,

        step,

        values

    ):

        self.page.wait_for_load_state(

            "networkidle"

        )

        return True

    def _navigate(

        self,

        step,

        values

    ):

        url = values.get(

            "url",

            step.action.value

        )

        if not url:

            return False

        self.page.goto(url)

        return True

    def _hover(

        self,

        step,

        values

    ):

        locator = self._locator(step.action.target)

        if locator is None:

            return False

        locator.hover()

        return True

    def _upload(

        self,

        step,

        values

    ):

        locator = self._locator(step.action.target)

        if locator is None:

            return False

        locator.set_input_files(

            values.get("file")

        )

        return True

    def _search(

        self,

        step,

        values

    ):

        return self.skill_executor.execute(

            "search",

            values.get("query", "")

        )


    def _login(

        self,

        step,

        values

    ):

        return self.skill_executor.execute(

            "login",

            values

        )


    def _pagination(

        self,

        step,

        values

    ):

        return self.skill_executor.execute(

            "pagination"

        )


    def _popup(

        self,

        step,

        values

    ):

        return self.skill_executor.execute(

            "popup"

        )


    def _table(

        self,

        step,

        values

    ):

        return self.skill_executor.execute(

            "table"

        )


    def _form_fill(

        self,

        step,

        values

    ):

        return self.skill_executor.execute(

            "form_fill",

            values

        )

    def _download(

        self,

        step,

        values

    ):

        return True