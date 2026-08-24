import speech_recognition as sr


class WakeWordDetector:
    def __init__(self, wake_word="nexus"):
        self.wake_word = wake_word.lower()
        self.wake_word_variants = [self.wake_word, "lexus", "nexis", "nexas", "nexxus", "next us"]
        self.recognizer = sr.Recognizer()
        self.recognizer.pause_threshold = 0.6
        self.recognizer.energy_threshold = 300
        self.recognizer.dynamic_energy_threshold = True

    def listen_raw(self):
        with sr.Microphone() as source:
            print("Listening for wake word...")
            audio = self.recognizer.listen(source, timeout=None, phrase_time_limit=None)
        try:
            text = self.recognizer.recognize_google(audio).lower()
            print("Heard:", text)
            return text
        except Exception:
            return None

    def _find_wake_variant(self, text):
        for variant in self.wake_word_variants:
            if variant in text:
                return variant
        return None

    def listen(self):
        text = self.listen_raw()
        return bool(text and self._find_wake_variant(text))

    def wait_with_command(self, max_attempts: int | None = None):
        attempts = 0
        while max_attempts is None or attempts < max_attempts:
            attempts += 1
            try:
                text = self.listen_raw()
            except KeyboardInterrupt:
                raise
            except Exception:
                continue
            if not text:
                continue
            variant = self._find_wake_variant(text)
            if variant:
                idx = text.find(variant)
                trailing = text[idx + len(variant):].strip()
                return True, trailing
        return False, None

    def wait(self, max_attempts: int | None = None) -> bool:
        found, _ = self.wait_with_command(max_attempts)
        return found
