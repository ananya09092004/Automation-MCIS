import re

import speech_recognition as sr

from voice.audio_source import SharedMicrophone
from voice import transcription

# en-IN recognizes Hinglish / Indian-accented speech noticeably better
# than the library default (en-US) for both the wake word and commands,
# without needing a separate language-detection round trip up front.
RECOGNITION_LANGUAGE = "en-IN"

# Audio shorter than this almost certainly isn't a real "Hey Nexus" --
# it's a stray noise blip or a very short ambient sound. Skipping
# transcription for these cuts down on false wake-ups and avoids wasting
# an STT call on audio that was never going to contain the wake phrase.
MIN_WAKE_AUDIO_SECONDS = 0.4

# Cap how long a single wake-word listen can run. Without this,
# background speech/TV audio with no real pause (a long sentence, a
# monologue) gets recorded and transcribed in full before we even get a
# chance to check it for the wake word -- wasteful and slow. "Hey Nexus"
# plus a bundled command is realistically well under this.
WAKE_PHRASE_TIME_LIMIT_SECONDS = 8


class WakeWordDetector:
    def __init__(self, wake_word="nexus", source=None):
        self.wake_word = wake_word.lower()
        self.wake_word_variants = [self.wake_word, "lexus", "nexis", "nexas", "nexxus", "next us"]
        self.recognizer = sr.Recognizer()
        self.recognizer.pause_threshold = 0.6
        self.recognizer.energy_threshold = 300
        self.recognizer.dynamic_energy_threshold = True
        # If no source is given, fall back to opening a fresh microphone
        # per call (old behavior) -- keeps this class usable standalone
        # (e.g. tests/test_wake_word.py) without requiring the shared mic.
        self.source = source

    def listen_raw(self):
        owns_source = self.source is None
        source = self.source or sr.Microphone()
        try:
            if owns_source:
                source.__enter__()
            print("Listening for wake word...")
            try:
                audio = self.recognizer.listen(
                    source,
                    timeout=None,
                    phrase_time_limit=WAKE_PHRASE_TIME_LIMIT_SECONDS,
                )
            except sr.WaitTimeoutError:
                return None
            except (KeyboardInterrupt, SystemExit):
                raise
            except Exception as error:
                # A raw audio-stream error (e.g. PyAudio buffer overflow,
                # which happens unpredictably under load) should never
                # kill wake-word listening -- log it and just skip this
                # cycle instead of letting it crash the whole process.
                print(f"[Nexus Voice] Mic read error while listening for wake word: {error}")
                return None
        finally:
            if owns_source:
                source.__exit__(None, None, None)

        try:
            duration = len(audio.frame_data) / (audio.sample_rate * audio.sample_width)
        except Exception:
            duration = None
        if duration is not None and duration < MIN_WAKE_AUDIO_SECONDS:
            return None

        text, _confidence = transcription.transcribe(audio, self.recognizer, RECOGNITION_LANGUAGE)
        if text:
            text = text.lower()
            print("Heard:", text)
        return text

    def _find_wake_variant(self, text):
        for variant in self.wake_word_variants:
            if variant in text:
                return variant
        return None

    @staticmethod
    def _has_real_content(text: str) -> bool:
        """True only if there's actual word content left, not just
        punctuation. STT engines (Whisper especially) often tack a
        trailing '!' or '.' onto "hey nexus" -- without this check that
        punctuation gets mistaken for a bundled command and acted on
        immediately, skipping the wake beep and the real listen step
        entirely."""
        cleaned = re.sub(r"[^\w\s]", "", text or "").strip()
        return len(cleaned) >= 2

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
                if not self._has_real_content(trailing):
                    trailing = ""
                return True, trailing
        return False, None

    def wait(self, max_attempts: int | None = None) -> bool:
        found, _ = self.wait_with_command(max_attempts)
        return found