
from browser.actions import BrowserActions
from browser.elements import ElementFinder

from browser.inspection.inspector import WebsiteInspector
from browser.intelligence.analyzer import ElementAnalyzer
from browser.intelligence.element_matcher import ElementMatcher

class ActionExecutor:

    def __init__(

        self,

        page

    ):

        self.page = page

        self.actions = BrowserActions()

        self.finder = ElementFinder(page)

        self.inspector = WebsiteInspector(page)

        self.analyzer = ElementAnalyzer(page)

        self.matcher = ElementMatcher()

    def execute(

        self,

        action

    ):

        print("\n========== ACTION ==========")
        print("ACTION :", action.action)
        print("TARGET :", action.target)
        print("VALUE  :", repr(action.value))
        print("============================")

        name = action.action

        target = action.target

        value = action.value

        locator = None

        if target:

            self.inspector.analyze()

            # --------------------------------
            # Wait for dynamically enabled fields
            # --------------------------------

            if name == "fill":

                if target == "password":

                    try:
                        self.page.locator(
                            'input[type="password"]'
                        ).first.wait_for(
                            state="visible",
                            timeout=3000
                        )

                    except Exception:
                        pass

                elements = self.analyzer.analyze_inputs()

            elif name == "click":

                elements = (

                    self.analyzer.analyze_buttons()

                    +

                    self.analyzer.analyze_links()

                )

            else:

                elements = self.analyzer.analyze_inputs()

                
            best = self.matcher.match(

                target,

                elements

            )


            print("=" * 60)
            print("TARGET:", target)

            if best:
                print("MATCHED")
                print("tag         :", best.tag)
                print("type        :", best.input_type)
                print("name        :", best.name)
                print("id          :", best.element_id)
                print("placeholder :", best.placeholder)
                print("aria        :", best.aria_label)
            else:
                print("NO MATCH")

            if best is None:

                return False

            locator = self.finder.from_element(

                best

            )

            if locator is None:

                return False

        if name == "fill":

            self.actions.fill(

                locator,

                value

            )

            # Username fill hone ke baad browser ko JS chalane ka time do
            if target == "username":
                self.page.wait_for_timeout(1000)
    

            return True

        if name == "click":

            self.actions.click(
                locator
            )

            try:
                self.page.wait_for_load_state(
                    "domcontentloaded",
                    timeout=5000
                )
            except Exception:
                pass

            self.page.wait_for_timeout(2000)

            return True

        if name == "press":

            self.actions.press(

                locator,

                value

            )

            return True

        if name == "hover":

            self.actions.hover(

                locator

            )

            return True

        if name == "focus":

            self.actions.focus(

                locator

            )

            return True

        if name == "check":

            self.actions.check(

                locator

            )

            return True

        if name == "uncheck":

            self.actions.uncheck(

                locator

            )

            return True

        if name == "select":

            self.actions.select(

                locator,

                value

            )

            return True

        return False