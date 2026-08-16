import speech_recognition as sr


class WakeWordDetector:

    def __init__(self, wake_word="nexus"):

        self.wake_word = wake_word.lower()

        self.recognizer = sr.Recognizer()

    def listen(self):

        with sr.Microphone() as source:

            print("Listening for wake word...")

            self.recognizer.adjust_for_ambient_noise(source, duration=0.5)

            audio = self.recognizer.listen(source)

        try:

            text = self.recognizer.recognize_google(audio).lower()

            print("Heard:", text)

            return self.wake_word in text

        except Exception:

            return False

    def wait(self, max_attempts: int | None = None) -> bool:
        """Block until the wake word is heard, retrying past silence/noise.

        A single microphone read often fails to catch the wake word (no
        speech, misheard audio, network hiccup for the Google recognizer).
        This loops so a caller can simply do ``if detector.wait(): ...``
        instead of re-implementing a retry loop, while still returning
        cleanly (instead of looping forever) if max_attempts is supplied
        -- useful for tests and for Ctrl+C-friendly shutdown checks.
        """
        attempts = 0
        while max_attempts is None or attempts < max_attempts:
            attempts += 1
            try:
                if self.listen():
                    return True
            except KeyboardInterrupt:
                raise
            except Exception:
                # A single bad audio frame should never kill the assistant.
                continue
        return False