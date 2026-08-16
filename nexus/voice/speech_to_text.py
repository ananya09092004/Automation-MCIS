import speech_recognition as sr

from voice.models import VoiceCommand


class SpeechRecognizer:

    def __init__(self):

        self.recognizer = sr.Recognizer()

    def listen(self):

        with sr.Microphone() as source:

            audio = self.recognizer.listen(source)

        text = self.recognizer.recognize_google(audio)

        return VoiceCommand(

            raw_text=text,

            cleaned_text=text.lower(),

            wake_word_detected=False,

            confidence=1.0

        )


class SpeechToText:
    """Plain-text speech capture used by VoiceController.

    voice_controller.py expects ``stt.listen()`` to return the spoken
    text as a plain string (or None if nothing recognizable was heard),
    not a VoiceCommand. Kept separate from SpeechRecognizer above so
    existing callers of the VoiceCommand-based path are unaffected.
    """

    def __init__(self):
        self.recognizer = sr.Recognizer()

    def listen(self) -> str | None:
        with sr.Microphone() as source:
            self.recognizer.adjust_for_ambient_noise(source, duration=0.3)
            audio = self.recognizer.listen(source)
        try:
            return self.recognizer.recognize_google(audio)
        except Exception:
            return None