from perception.ui_detector.models import UIElement


class UIMatcher:

    BUTTON_WORDS = {

        "ok",
        "yes",
        "no",
        "submit",
        "save",
        "cancel",
        "continue",
        "next",
        "finish",
        "close",
        "login",
        "log in",
        "sign in",
        "signup",
        "sign up",
        "register",
        "install",
        "download",
        "upload",
        "open",
        "search",
        "update",
        "delete",
        "remove",
        "edit",
        "apply",
        "allow",
        "accept",
        "confirm",
        "send",
        "retry",
        "refresh",
        "skip",
        "done",
        "start",
        "stop",
        "launch",
        "create",
        "new"

    }

    INPUT_WORDS = {

        "search",
        "username",
        "email",
        "password",
        "phone",
        "address",
        "name",
        "message",
        "comment"

    }

    def classify(self, element: UIElement) -> UIElement:

        text = element.text.strip().lower()

        if text in self.BUTTON_WORDS:

            element.element_type = "button"
            element.clickable = True

        elif text in self.INPUT_WORDS:

            element.element_type = "input"
            element.editable = True
            element.clickable = True

        else:

            element.element_type = "text"

        return element

    def classify_all(self, elements):

        return [

            self.classify(item)

            for item in elements

        ]