import os

from groq import Groq


class NexusLLM:

    def __init__(self):

        api_key = os.getenv("GROQ_API_KEY")

        # A missing key should not crash the whole assistant on startup --
        # e.g. wake-word/desktop-automation testing shouldn't require an
        # API key. Construct with a placeholder so failure happens (with a
        # clear message) only when a chat/plan call is actually made.
        self.client = Groq(api_key=api_key or "not-configured")

        self._api_key_missing = not api_key

        self.history = [

            {

                "role": "system",

                "content": """
You are Nexus.

You are a highly intelligent AI assistant.

Your personality:

- Friendly
- Fast
- Professional
- Short answers unless user asks for details.
- Never mention you are ChatGPT.
- Behave like Nexus AI OS.

If user asks browser tasks,
answer normally for now.
Later browser automation will handle them.
"""

            }

        ]

    def ask(

        self,

        message: str

    ) -> str:

        if self._api_key_missing:
            return (
                "Nexus AI brain is not configured yet -- set the "
                "GROQ_API_KEY environment variable and restart."
            )

        self.history.append(

            {

                "role": "user",

                "content": message

            }

        )

        response = self.client.chat.completions.create(

            model="llama-3.3-70b-versatile",

            messages=self.history,

            temperature=0.7,

            max_tokens=300

        )

        answer = (

            response

            .choices[0]

            .message

            .content

            .strip()

        )

        self.history.append(

            {

                "role": "assistant",

                "content": answer

            }

        )

        return answer

    def clear(self):

        system = self.history[0]

        self.history = [

            system

        ]