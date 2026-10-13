from voice.wake_word import WakeWordDetector

from voice.speech_to_text import SpeechRecognizer

from voice.command_router import CommandRouter

from voice.text_to_speech import Speaker


class VoiceAssistant:

    def __init__(self):

        self.wake = WakeWordDetector()

        self.listener = SpeechRecognizer()

        self.router = CommandRouter()

        self.speaker = Speaker()

    def listen(self):

        if not self.wake.listen():

            return None

        command = self.listener.listen()

        return self.router.route(command)