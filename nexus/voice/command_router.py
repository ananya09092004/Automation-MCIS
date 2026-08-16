class CommandRouter:

    def route(

        self,

        command

    ):

        text = command.cleaned_text

        if text.startswith("nexus"):

            text = text.replace(

                "nexus",

                "",

                1

            ).strip()

        return text