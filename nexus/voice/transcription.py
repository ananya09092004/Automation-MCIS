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


def _transcribe_with_google(audio, google_recognizer, google_language):
    """Only ever called for a genuine Whisper TECHNICAL_FAILURE (API/
    network/decoding error, or Whisper unavailable/unconfigured) -- see
    the trust-boundary comment in transcribe() below. Google's output
    still isn't blindly trusted as a command: it flows back through the
    exact same downstream safety nets every transcription does (the
    pre-STT silence gate, the low-confidence confirm-back in
    voice_controller.py) -- it just has no per-call hallucination/
    confidence check of its own here, since the Google Web Speech API
    doesn't return the segment-level logprob/no_speech_prob data Whisper
    does, so there's nothing to score."""
    try:
        text = google_recognizer.recognize_google(audio, language=google_language)
        return (text, None) if text else (None, None)
    except Exception:
        return None, None


def transcribe(audio, google_recognizer, google_language="en-IN"):
    """
    Transcribe an sr.AudioData capture.

    TRUST BOUNDARY (this is the important part -- read before changing):
    There are two fundamentally different reasons a transcription result
    might not be usable, and they must NEVER be handled the same way:

      1. TECHNICAL_FAILURE -- Whisper itself couldn't be asked at all:
         the API call raised (network/provider error, decoding failure),
         or there's no usable Groq client (unconfigured/disabled). In
         this case we genuinely have no answer yet, so asking Google
         instead is the right move -- it's a different question ("can
         ANY engine transcribe this audio") than the ones below.

      2. Whisper WAS asked, WAS able to answer, and gave an answer we
         then judged unusable -- either SILENCE/NO_SPEECH (empty text)
         or HALLUCINATION/FILTERED_SPEECH (low confidence / a known
         filler phrase Whisper invents on quiet audio). This is NOT a
         technical failure -- Whisper succeeded at its job and the
         answer was "nothing was really said here". Falling through to
         Google for a second opinion on the SAME audio in this case is
         exactly how a deliberately-rejected hallucination gets
         resurrected: Google, having no confidence/hallucination
         checking of its own, can transcribe the same noise into
         similar-looking text and that text would then be wrongly
         accepted as a real user command. This function returns
         (None, None) immediately for both SILENCE and HALLUCINATION
         outcomes WITHOUT ever calling Google for that same audio again.

    Returns (text, confidence):
      - text: transcribed string, or None if nothing usable was heard
        (covers SILENCE, HALLUCINATION, and TECHNICAL_FAILURE-with-no-
        Google-result alike -- callers already treat None uniformly as
        "nothing to act on")
      - confidence: float 0..1 when Whisper succeeded and returned
        usable segment data, otherwise None (unknown -- e.g. the Google
        fallback path was used, which has no confidence signal)
    """
    client = _get_groq_client()

    if client is None:
        # No usable Whisper client at all -- this is an infrastructure/
        # configuration condition (TECHNICAL_FAILURE), not a rejection of
        # anything Whisper said, so Google fallback is appropriate.
        return _transcribe_with_google(audio, google_recognizer, google_language)

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
    except Exception as error:
        # TECHNICAL_FAILURE: the Whisper call itself blew up (network,
        # API, decoding). We have no answer from Whisper at all here --
        # asking Google is the correct fallback.
        print(f"[Nexus Voice] Groq transcription technical failure, falling back to Google: {error}")
        return _transcribe_with_google(audio, google_recognizer, google_language)

    # Whisper responded successfully. Everything below is a VALID_SPEECH /
    # SILENCE / HALLUCINATION determination on an answer Whisper actually
    # gave us -- NOT a technical failure -- so Google is never consulted
    # past this point for this audio, no matter what we decide below.
    text = (getattr(result, "text", "") or "").strip()
    if not text:
        # SILENCE / NO_SPEECH.
        return None, None

    confidence = _confidence_from_segments(getattr(result, "segments", None))
    normalized = text.lower().strip(" .!?")

    low_confidence = confidence is not None and confidence < _LOW_CONFIDENCE_DISCARD
    unconvincing_filler = normalized in _HALLUCINATION_PHRASES and (
        confidence is None or confidence < _HALLUCINATION_PHRASE_DISCARD
    )

    if low_confidence or unconvincing_filler:
        # HALLUCINATION / FILTERED_SPEECH. Almost certainly noise, not
        # something the user actually said. Whisper succeeded and this IS
        # its answer -- we're choosing not to trust it, which is exactly
        # why Google must NOT be asked to re-transcribe this same audio
        # (see the trust-boundary docstring above).
        print(f"[Nexus Voice] Discarding likely hallucinated transcription: {text!r} (confidence={confidence})")
        return None, None

    # VALID_SPEECH.
    return text, confidence