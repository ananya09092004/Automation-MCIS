"""
Shared speech-to-text transcription helper for the Nexus voice pipeline.

Primary engine: Groq's hosted Whisper (whisper-large-v3-turbo) -- far more
accurate and reliable than the free/unofficial Google Web Speech API,
especially for Hindi/Hinglish and accented English.

Safety net: if GROQ_API_KEY isn't set, the groq package/call fails, or the
response comes back in an unexpected shape, this transparently falls back
to the existing Google recognizer path. Nothing about voice commands stops
working just because Groq is unreachable or unconfigured -- this was a
deliberate design requirement, not an oversight.
"""

import os

_GROQ_CLIENT = None
_GROQ_DISABLED = False


def _get_groq_client():
    """Lazily build (and cache) the Groq client. Returns None if Groq
    isn't usable for any reason -- callers must treat None as "use the
    fallback recognizer", never as an error to raise."""
    global _GROQ_CLIENT, _GROQ_DISABLED

    if _GROQ_DISABLED:
        return None

    if _GROQ_CLIENT is None:
        api_key = os.getenv("GROQ_API_KEY")
        if not api_key:
            _GROQ_DISABLED = True
            return None
        try:
            from groq import Groq
            _GROQ_CLIENT = Groq(api_key=api_key)
        except Exception as error:
            print(f"[Nexus Voice] Groq STT unavailable, using fallback recognizer: {error}")
            _GROQ_DISABLED = True
            return None

    return _GROQ_CLIENT


_HALLUCINATION_PHRASES = {
    # Whisper is well-known to "hallucinate" these exact filler phrases
    # (trained on huge amounts of YouTube audio) when the actual input
    # was silence or near-silence, rather than admitting it heard
    # nothing. Deliberately does NOT include short words that are also
    # legitimate confirmation answers elsewhere in the app ("yes", "no",
    # "okay", "haan") -- filtering those would break the confirm/deny
    # flow whenever the user answers quietly.
    "thank you", "thank you.", "thanks for watching", "thanks for watching!",
    "thank you for watching", "thank you so much for watching",
    "please subscribe", "please subscribe.", "bye", "bye.", "you", "you.",
    "see you next time", "see you in the next video", "i'll see you next time",
    "hmm", "hmm.", "hm", "hm.", "um", "um.", "uh", "uh.",
    "i don't know", "i don't know.", "i don't know how to do it",
    "i'm going to go", "i'm going to go.", "i'm going to go to the next one",
}

# Below this confidence, treat ANY transcription as unreliable noise and
# discard it, regardless of what the text says. This is the primary
# catch-all: Whisper hallucinates plenty of text that will never fit in
# a fixed phrase list above (odd invented sentences on near-silent
# audio, e.g. "i don't know how to do it" or "i'm going to go" heard on
# an empty room) -- the phrase list can't be exhaustive, but a low
# combined logprob/no_speech confidence reliably flags them anyway.
_LOW_CONFIDENCE_DISCARD = 0.35

# Higher bar used ONLY for the known-filler-phrase list above. Whisper
# is often deceptively "confident" about these specific phrases because
# it saw them so often in training data, so a confidence just above the
# general noise floor (the old 0.4 cutoff) still wasn't enough to catch
# them reliably -- this is why "Thank you." kept slipping through as a
# real command in testing even though it was pure background noise.
_HALLUCINATION_PHRASE_DISCARD = 0.65


def _confidence_from_segments(segments):
    """Turn Whisper's per-segment avg_logprob AND no_speech_prob into a
    rough 0..1 confidence score. Returns None if segments are missing or
    in an unexpected shape -- callers treat None as "confidence unknown",
    not "low confidence"."""
    if not segments:
        return None

    try:
        def _get(seg, key):
            return seg.get(key) if isinstance(seg, dict) else getattr(seg, key, None)

        logprobs = [float(v) for seg in segments if (v := _get(seg, "avg_logprob")) is not None]
        no_speech_probs = [float(v) for seg in segments if (v := _get(seg, "no_speech_prob")) is not None]

        if not logprobs and not no_speech_probs:
            return None

        logprob_conf = None
        if logprobs:
            avg_logprob = sum(logprobs) / len(logprobs)
            # avg_logprob is typically in roughly [-1.5, 0] for Whisper;
            # map that to an approximate 0..1 confidence score.
            logprob_conf = max(0.0, min(1.0, 1.0 + (avg_logprob / 1.5)))

        speech_conf = None
        if no_speech_probs:
            avg_no_speech = sum(no_speech_probs) / len(no_speech_probs)
            # High no_speech_prob means Whisper itself isn't sure this
            # was real speech -- this is exactly what fires on the
            # "Thank you." / "you" hallucinations seen on quiet audio.
            speech_conf = max(0.0, min(1.0, 1.0 - avg_no_speech))

        candidates = [c for c in (logprob_conf, speech_conf) if c is not None]
        if not candidates:
            return None
        # Take the more pessimistic of the two signals -- either one
        # alone flagging trouble is enough to not trust this blindly.
        return min(candidates)
    except Exception:
        return None


def transcribe(audio, google_recognizer, google_language="en-IN"):
    """
    Transcribe an sr.AudioData capture.

    Returns (text, confidence):
      - text: transcribed string, or None if nothing could be recognized
        by either engine
      - confidence: float 0..1 when Groq/Whisper succeeded and returned
        usable segment data, otherwise None (unknown -- e.g. Google
        fallback was used, which has no confidence signal)
    """
    client = _get_groq_client()

    if client is not None:
        try:
            wav_bytes = audio.get_wav_data()
            result = client.audio.transcriptions.create(
                file=("command.wav", wav_bytes),
                model="whisper-large-v3-turbo",
                response_format="verbose_json",
                # Force English/Romanized output so downstream keyword
                # matching (stop phrases, trailing-word heuristics, etc.,
                # all written in Latin script) keeps working exactly as
                # before -- auto-detect could switch to Devanagari script
                # for Hindi speech and silently break that matching.
                language="en",
            )
            text = (getattr(result, "text", "") or "").strip()
            if text:
                confidence = _confidence_from_segments(getattr(result, "segments", None))
                normalized = text.lower().strip(" .!?")

                low_confidence = confidence is not None and confidence < _LOW_CONFIDENCE_DISCARD
                unconvincing_filler = normalized in _HALLUCINATION_PHRASES and (
                    confidence is None or confidence < _HALLUCINATION_PHRASE_DISCARD
                )

                if low_confidence or unconvincing_filler:
                    # Almost certainly noise/silence, not something the
                    # user actually said -- treat as nothing heard rather
                    # than acting on it or even asking the user to
                    # confirm meaningless text.
                    print(f"[Nexus Voice] Discarding likely hallucinated transcription: {text!r} (confidence={confidence})")
                else:
                    return text, confidence
            # Empty (or discarded-as-hallucination) transcription isn't
            # necessarily wrong -- fall through to Google as a second
            # opinion rather than giving up immediately.
        except Exception as error:
            print(f"[Nexus Voice] Groq transcription failed, falling back to Google: {error}")

    try:
        text = google_recognizer.recognize_google(audio, language=google_language)
        return (text, None) if text else (None, None)
    except Exception:
        return None, None