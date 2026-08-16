import pyttsx3


class Speaker:

    def __init__(self):
        self.rate = 175
        self.volume = 1.0

    def speak(self, text: str):

        if not text:
            return

        print("NEXUS SPEAKING:", text)

        # Fresh Windows TTS engine for every utterance.
        # This avoids pyttsx3/SAPI getting stuck after the first speech.
        engine = pyttsx3.init()

        engine.setProperty(
            "rate",
            self.rate
        )

        engine.setProperty(
            "volume",
            self.volume
        )

        voices = engine.getProperty("voices")

        if voices:
            engine.setProperty(
                "voice",
                voices[0].id
            )

        engine.say(str(text))
        engine.runAndWait()
        engine.stop()


TextToSpeech = Speaker