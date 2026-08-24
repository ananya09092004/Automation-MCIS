import speech_recognition as sr

from voice.models import VoiceCommand


class SpeechRecognizer:

    def __init__(self):
        self.recognizer = sr.Recognizer()
        self.recognizer.pause_threshold = 2
        self.recognizer.energy_threshold = 300
        self.recognizer.dynamic_energy_threshold = True

    def listen(self):
        with sr.Microphone() as source:
            audio = self.recognizer.listen(source, timeout=None, phrase_time_limit=None)

        text = self.recognizer.recognize_google(audio)

        return VoiceCommand(
            raw_text=text,
            cleaned_text=text.lower(),
            wake_word_detected=False,
            confidence=1.0
        )


class SpeechToText:
    # Plain-text speech capture used by VoiceController.
    # stt.listen() returns the spoken text as a plain string (or None if
    # nothing recognizable was heard), not a VoiceCommand.
    #
    # pause_threshold = 2: seconds of silence before recording is
    # considered "done" -- long enough that a brief mid-sentence pause
    # doesn't cut the user off, short enough to feel responsive.

    def __init__(self):
        self.recognizer = sr.Recognizer()
        self.recognizer.pause_threshold = 2
        self.recognizer.energy_threshold = 300
        self.recognizer.dynamic_energy_threshold = True

    def listen(self) -> str | None:
        with sr.Microphone() as source:
            try:
                audio = self.recognizer.listen(source, timeout=None, phrase_time_limit=None)
            except sr.WaitTimeoutError:
                return None
        try:
            return self.recognizer.recognize_google(audio)
        except Exception:
            return None