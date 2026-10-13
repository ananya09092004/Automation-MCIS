from browser.interaction import SafeExecutor


class PopupSkill:

    CLOSE_SELECTORS = [

        '.modal-footer p',

        '.modal-footer a',

        '.modal-footer',

        '.modal .modal-footer p',

        '.modal .modal-footer a',

        '[aria-label*="close" i]',

        '[aria-label*="dismiss" i]',

        'button:has-text("Close")',

        'a:has-text("Close")',

        'button:has-text("Cancel")',

        'button:has-text("No Thanks")',

        'button:has-text("Not now")',

        'button:has-text("Skip")',

        '.close',

        '.popup-close',

        '.modal-close'

    ]
    def __init__(

        self,

        page

    ):

        self.page = page

        self.executor = SafeExecutor(page)

    def close(self):

        for selector in self.CLOSE_SELECTORS:

            try:

                locator = self.page.locator(selector).first

                if locator.count() == 0:
                    continue

                if not locator.is_visible():
                    continue

                locator.scroll_into_view_if_needed()

                self.executor.execute(

                    locator,

                    lambda l: l.click()

                )

                return True

            except Exception:

                continue

        return False

    def accept_alert(self):

        self.page.once(

            "dialog",

            lambda dialog: dialog.accept()

        )

        return True

    def dismiss_alert(self):

        self.page.once(

            "dialog",

            lambda dialog: dialog.dismiss()

        )

        return True