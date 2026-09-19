"""Regression tests for the Whisper->Google STT trust boundary
(nexus/voice/transcription.py).

These lock in the fix where Google fallback must ONLY run for a genuine
Whisper TECHNICAL_FAILURE (API/network/decode error, or no client at
all) -- never after Whisper successfully answered and that answer was
rejected as SILENCE or a HALLUCINATION. Before the fix, a rejected
hallucination could be "resurrected" by asking Google to transcribe the
same audio, and Google -- having no confidence/hallucination checking of
its own -- could produce similar text that then got wrongly accepted as
a real user command.

No real audio, network, or Groq/Google API access is used or required --
everything here mocks the client boundary and tests the actual control-
flow logic in transcription.py.
"""

import voice.transcription as tr


class _FakeSegment:
    def __init__(self, avg_logprob, no_speech_prob):
        self.avg_logprob = avg_logprob
        self.no_speech_prob = no_speech_prob


class _FakeWhisperResult:
    def __init__(self, text, segments):
        self.text = text
        self.segments = segments


class _FakeGoogleRecognizer:
    """Records how many times it was actually called -- the core thing
    every test here needs to check."""

    def __init__(self, return_text):
        self.return_text = return_text
        self.call_count = 0

    def recognize_google(self, audio, language=None):
        self.call_count += 1
        if self.return_text is None:
            raise Exception("no speech")
        return self.return_text


class _FakeAudio:
    def get_wav_data(self):
        return b"fake"


def _set_groq_client(client):
    tr._GROQ_CLIENT = client
    tr._GROQ_DISABLED = False


def test_hallucination_is_rejected_and_google_is_never_called():
    """TEST A: Whisper successfully answers with a low-confidence,
    filler-like hallucination -> rejected, Google must NOT be asked to
    re-transcribe the same audio."""

    class FakeClient:
        class audio:
            class transcriptions:
                @staticmethod
                def create(**kwargs):
                    return _FakeWhisperResult(
                        "I'm going to go to the next one.",
                        [_FakeSegment(avg_logprob=-2.0, no_speech_prob=0.9)],  # very low confidence
                    )

    _set_groq_client(FakeClient())
    google = _FakeGoogleRecognizer(return_text="I'm going to go to the next one")

    text, confidence = tr.transcribe(_FakeAudio(), google, "en-IN")

    assert text is None
    assert google.call_count == 0, "Google must NEVER be called after a Whisper hallucination rejection"


def test_silence_is_rejected_and_google_is_never_called():
    """TEST B: Whisper successfully answers with empty text (silence) ->
    Google must NOT be called."""

    class FakeClient:
        class audio:
            class transcriptions:
                @staticmethod
                def create(**kwargs):
                    return _FakeWhisperResult("", [])

    _set_groq_client(FakeClient())
    google = _FakeGoogleRecognizer(return_text="something")

    text, confidence = tr.transcribe(_FakeAudio(), google, "en-IN")

    assert text is None
    assert google.call_count == 0


def test_genuine_technical_failure_allows_google_fallback():
    """TEST C: the Whisper API call itself raises (network/provider
    error) -> this IS a technical failure, Google fallback is
    appropriate and should run."""

    class FakeClient:
        class audio:
            class transcriptions:
                @staticmethod
                def create(**kwargs):
                    raise ConnectionError("Groq API unreachable")

    _set_groq_client(FakeClient())
    google = _FakeGoogleRecognizer(return_text="open notepad")

    text, confidence = tr.transcribe(_FakeAudio(), google, "en-IN")

    assert google.call_count == 1, "Google SHOULD be called after a genuine technical failure"
    assert text == "open notepad"


def test_google_result_after_technical_failure_carries_no_false_confidence():
    """TEST D: Google's fallback result must still flow through the same
    return contract as any other transcription (confidence=None, since
    Google has no per-segment confidence signal) -- callers downstream
    (voice_controller.py's low-confidence confirm-back) rely on this."""

    class FakeClient:
        class audio:
            class transcriptions:
                @staticmethod
                def create(**kwargs):
                    raise ConnectionError("Groq API unreachable")

    _set_groq_client(FakeClient())
    google = _FakeGoogleRecognizer(return_text="switch to chrome")

    text, confidence = tr.transcribe(_FakeAudio(), google, "en-IN")

    assert text == "switch to chrome"
    assert confidence is None


def test_valid_speech_is_accepted_without_ever_consulting_google():
    """Regression: genuine, confident speech must still work exactly as
    before -- Google is never consulted when Whisper's answer is good."""

    class FakeClient:
        class audio:
            class transcriptions:
                @staticmethod
                def create(**kwargs):
                    return _FakeWhisperResult(
                        "open notepad",
                        [_FakeSegment(avg_logprob=-0.1, no_speech_prob=0.02)],  # high confidence
                    )

    _set_groq_client(FakeClient())
    google = _FakeGoogleRecognizer(return_text="should never be used")

    text, confidence = tr.transcribe(_FakeAudio(), google, "en-IN")

    assert text == "open notepad"
    assert google.call_count == 0
