import speech_recognition as sr

from voice.models import VoiceCommand
from voice.audio_source import SharedMicrophone
from voice import transcription

RECOGNITION_LANGUAGE = "en-IN"

# Words that, when they're the LAST word transcribed, are a strong signal
# the user hadn't actually finished the sentence (Google's own silence
# detector just happened to catch a breath/thinking pause there). Covers
# common English trailing/conjunction words plus their Hinglish
# equivalents, since users often speak Hindi-English mixed commands.
_TRAILING_INCOMPLETE_WORDS = {
    "and", "or", "but", "so", "because", "the", "a", "an", "to", "for",
    "with", "that", "then", "is", "of", "in", "on", "at",
    "aur", "ki", "ke", "ko", "se", "toh", "to", "phir", "fir",
    "uske", "kyunki", "wala", "wali", "wale", "mein", "hai",
}


def _looks_incomplete(text: str, spoken_seconds: float) -> bool:
    stripped = (text or "").strip()
    if not stripped:
        return True
    last_word = stripped.split()[-1].lower().rstrip(".,?!")
    if last_word in _TRAILING_INCOMPLETE_WORDS:
        return True
    # Very short utterances are often the start of a word that got cut off
    # rather than a genuine one-word command.
    if spoken_seconds < 0.9:
        return True
    return False


def _audio_seconds(audio: "sr.AudioData") -> float:
    try:
        return len(audio.frame_data) / (audio.sample_rate * audio.sample_width)
    except Exception:
        return 0.0


def _concat_audio(pieces):
    """Join multiple AudioData captures (separated by short thinking
    pauses) into a single AudioData for transcription, so a hesitation
    doesn't split one command into two failed recognitions."""
    if len(pieces) == 1:
        return pieces[0]

    sample_rate = pieces[0].sample_rate
    sample_width = pieces[0].sample_width
    # Small inserted silence between segments -- the actual pause itself
    # isn't captured (recognizer.listen() drops leading silence), this
    # just keeps word boundaries clean when the pieces are joined.
    silence_pad = b"\x00" * int(sample_rate * sample_width * 0.3)

    frames = pieces[0].get_raw_data(convert_rate=sample_rate, convert_width=sample_width)
    for piece in pieces[1:]:
        frames += silence_pad + piece.get_raw_data(convert_rate=sample_rate, convert_width=sample_width)

    return sr.AudioData(frames, sample_rate, sample_width)


class SpeechRecognizer:

    def __init__(self):
        self.recognizer = sr.Recognizer()
        self.recognizer.pause_threshold = 2
        self.recognizer.energy_threshold = 300
        self.recognizer.dynamic_energy_threshold = True

    def listen(self):
        with sr.Microphone() as source:
            audio = self.recognizer.listen(source, timeout=None, phrase_time_limit=None)

        text = self.recognizer.recognize_google(audio, language=RECOGNITION_LANGUAGE)

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
    # Endpointing strategy (adaptive, not a fixed cutoff):
    #   1. Listen with a responsive base pause_threshold -- good for
    #      short/simple commands, which is most of them, so we don't add
    #      latency to the common case.
    #   2. If what came back looks like it might not be finished (trailing
    #      conjunction word, or a suspiciously short utterance), give the
    #      user a short grace window to keep talking instead of assuming
    #      they're done. If they resume, the new audio is stitched onto
    #      the previous piece and re-checked -- this can repeat a few
    #      times for genuinely long commands with several pauses.
    #   3. If nothing looks incomplete, or the grace window times out with
    #      no more speech, finalize immediately.
    #
    # This means a fast one-word command still returns fast, while a long
    # hesitant command gets as many grace windows as it actually needs,
    # rather than everyone paying for one large fixed timeout.

    MAX_CONTINUATIONS = 4
    CONTINUATION_GRACE_SECONDS = 2.5

    def __init__(self, source=None):
        self.recognizer = sr.Recognizer()
        self.recognizer.pause_threshold = 1.0
        self.recognizer.energy_threshold = 300
        self.recognizer.dynamic_energy_threshold = True
        # If a shared source is passed in (from VoiceController), use it
        # directly. Otherwise fall back to the shared-mic helper so we
        # still avoid a cold-open on every call.
        self.source = source

    def _transcribe(self, audio):
        """Returns (text, confidence). confidence is None when unknown
        (Google fallback path, or nothing recognized)."""
        return transcription.transcribe(audio, self.recognizer, RECOGNITION_LANGUAGE)

    def listen_with_confidence(self):
        """Same capture/endpointing logic as listen(), but also returns
        the confidence score (0..1, or None if unknown) of the final
        transcription -- used by VoiceController to decide whether to
        double-check an unclear command with the user before acting on
        it.

        Any audio-stream error (e.g. a PyAudio buffer overflow, which
        happens unpredictably under system load) is caught and treated
        as "didn't hear anything" rather than being allowed to propagate
        -- an uncaught error here would otherwise silently crash the
        entire voice process, which looks exactly like the mic randomly
        going dead with no pattern."""
        source = self.source or SharedMicrophone.get()

        try:
            audio = self.recognizer.listen(source, timeout=None, phrase_time_limit=None)
        except sr.WaitTimeoutError:
            return None, None
        except (KeyboardInterrupt, SystemExit):
            raise
        except Exception as error:
            print(f"[Nexus Voice] Mic read error, will keep listening: {error}")
            return None, None

        pieces = [audio]
        text, confidence = self._transcribe(audio)
        spoken_seconds = _audio_seconds(audio)

        continuations = 0
        while continuations < self.MAX_CONTINUATIONS and _looks_incomplete(text, spoken_seconds):
            try:
                more = self.recognizer.listen(
                    source,
                    timeout=self.CONTINUATION_GRACE_SECONDS,
                    phrase_time_limit=None,
                )
            except sr.WaitTimeoutError:
                break
            except (KeyboardInterrupt, SystemExit):
                raise
            except Exception as error:
                print(f"[Nexus Voice] Mic read error during continuation, using what we have: {error}")
                break

            pieces.append(more)
            combined = _concat_audio(pieces)
            text, confidence = self._transcribe(combined)
            spoken_seconds += _audio_seconds(more)
            continuations += 1

        return text, confidence

    def listen(self) -> str | None:
        text, _confidence = self.listen_with_confidence()
        return text