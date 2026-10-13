from dataclasses import dataclass
import re


@dataclass
class Intent:

    category: str

    confidence: float

    payload: str


class IntentRouter:

    # Matches a filename with a document-ish extension anywhere in the
    # command (e.g. "resume.docx", "notes.txt", "Q3 report.pdf"). Keyword
    # lists below are necessarily incomplete (can't enumerate every way
    # someone phrases a task), but a real file reference is a strong,
    # reliable signal that this is a desktop task -- covering commands
    # like "resume.docx mein changes karo" that don't contain any of the
    # hand-picked desktop_keywords.
    _FILE_REFERENCE = re.compile(
        r"\b[\w .-]+\.(docx?|txt|md|pdf|xlsx?|pptx?|csv)\b", re.IGNORECASE
    )

    def __init__(self):

        self.browser_keywords = {

            "open",
            "search",
            "click",
            "login",
            "logout",
            "download",
            "upload",
            "book",
            "buy",
            "fill",
            "website",
            "browser",
            "github",
            "google",
            "amazon",
            "youtube",
            "gmail",
            "linkedin"
        }

        self.desktop_keywords = {

            "folder",
            "file",
            "desktop",
            "windows",
            "application",
            "notepad",
            "calculator",
            "document",
            "resume",
            "edit",
            "rewrite"
        }

        self.chat_keywords = {

            "who",

            "what",

            "why",

            "how",

            "explain",

            "tell",

            "hello",

            "hi"

        }

    def route(

        self,

        text: str

    ) -> Intent:

        command = text.lower()

        if self._FILE_REFERENCE.search(command):

            return Intent(

                category="desktop",

                confidence=0.95,

                payload=text

            )

        for word in self.browser_keywords:

            if word in command:

                return Intent(

                    category="browser",

                    confidence=0.95,

                    payload=text

                )

        for word in self.desktop_keywords:

            if word in command:

                return Intent(

                    category="desktop",

                    confidence=0.90,

                    payload=text

                )

        for word in self.chat_keywords:

            if word in command:

                return Intent(

                    category="chat",

                    confidence=0.90,

                    payload=text

                )

        return Intent(

            category="chat",

            confidence=0.60,

            payload=text

        )