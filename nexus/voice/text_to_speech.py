import threading

import pyttsx3

try:
    from langdetect import detect, LangDetectException
except Exception:  # pragma: no cover - langdetect already a hard dependency elsewhere
    detect = None
    LangDetectException = Exception

# Installed voices don't change while the process is running, so we only
# need to scan them once and reuse the map -- avoids re-scanning on every
# single utterance (a fresh pyttsx3 engine is still created per utterance
# below, that part is unchanged and intentional, see note in speak()).
_VOICE_MAP = None


def _build_voice_map():
    probe = pyttsx3.init()
    try:
        voices = probe.getProperty("voices") or []
        voice_map = {"default": voices[0].id if voices else None}

        for voice in voices:
            try:
                langs = [str(l).lower() for l in (voice.languages or [])]
            except Exception:
                langs = []
            haystack = " ".join(langs) + " " + (voice.id or "").lower() + " " + (voice.name or "").lower()

            if "hi" in voice_map:
                continue
            if "hi-in" in haystack or "hindi" in haystack or "_hi_" in haystack or haystack.strip().startswith("hi "):
                voice_map["hi"] = voice.id

        return voice_map
    finally:
        try:
            probe.stop()
        except Exception:
            pass


def _get_voice_map():
    global _VOICE_MAP
    if _VOICE_MAP is None:
        try:
            _VOICE_MAP = _build_voice_map()
        except Exception:
            _VOICE_MAP = {"default": None}
    return _VOICE_MAP


class Speaker:

    def __init__(self):
        self.rate = 175
        self.volume = 1.0

    def _pick_voice_id(self, text: str):
        voice_map = _get_voice_map()

        lang = "en"
        if detect is not None and text.strip():
            try:
                lang = detect(text)
            except LangDetectException:
                lang = "en"

        if lang == "hi" and "hi" in voice_map:
            return voice_map["hi"]
        return voice_map.get("default")

    def speak(self, text: str, interrupt_event: "threading.Event | None" = None):
        """
        Speak text. If interrupt_event is given and gets set while this
        is talking (e.g. the user presses the mute hotkey), the speech
        is cut short instead of running to completion -- a deliberately
        conservative, low-risk form of "let the user interrupt me"
        rather than full continuous barge-in (which would need a second
        live audio stream running during playback and risks feedback/
        false triggers on a single-mic setup).
        """

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

        voice_id = self._pick_voice_id(text)
        if voice_id:
            engine.setProperty("voice", voice_id)

        engine.say(str(text))

        watcher = None
        if interrupt_event is not None:
            def _watch_for_interrupt():
                interrupt_event.wait()
                try:
                    engine.stop()
                except Exception:
                    pass

            watcher = threading.Thread(target=_watch_for_interrupt, daemon=True)
            watcher.start()

        engine.runAndWait()
        engine.stop()


TextToSpeech = Speaker