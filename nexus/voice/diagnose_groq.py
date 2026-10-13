"""
Standalone diagnostic -- run this directly to check whether Groq/Whisper
is actually being used by the voice pipeline, or silently falling back
to Google every time.

Usage (from inside the nexus/ folder):
    python voice/diagnose_groq.py
"""

import io
import os
import wave

from dotenv import load_dotenv

load_dotenv()

print("=" * 60)
print("STEP 1: Is GROQ_API_KEY loaded from nexus/.env at all?")
print("=" * 60)

key = os.getenv("GROQ_API_KEY")

if not key:
    print("[FAIL] GROQ_API_KEY is NOT set in the environment.")
    print("       Check that nexus/.env exists and contains a line like:")
    print("       GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")
    raise SystemExit(1)

print(f"[OK] GROQ_API_KEY found, length = {len(key)} characters")
print(f"     Starts with: {key[:6]}...  Ends with: ...{key[-4:]}")

if len(key) < 40:
    print()
    print("[WARNING] This key looks shorter than a normal Groq key (~56 chars).")
    print("          It may have been truncated when copy-pasted.")

print()
print("=" * 60)
print("STEP 2: Does the actual Whisper transcription endpoint work?")
print("        (this is the exact model/endpoint the voice pipeline uses)")
print("=" * 60)


def _make_silent_wav_bytes(seconds=1, sample_rate=16000):
    """A tiny valid WAV file (near-silence) -- just enough for the API
    to accept the request and prove the endpoint/key/model actually
    work end to end. The transcribed text itself doesn't matter here."""
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(b"\x00\x00" * sample_rate * seconds)
    return buffer.getvalue()


try:
    from groq import Groq
    client = Groq(api_key=key)

    wav_bytes = _make_silent_wav_bytes()
    result = client.audio.transcriptions.create(
        file=("test.wav", wav_bytes),
        model="whisper-large-v3-turbo",
        response_format="verbose_json",
        language="en",
    )
    print(f"[OK] Groq Whisper API call succeeded.")
    print(f"     Response text (empty is expected/fine, this was silence): {getattr(result, 'text', '')!r}")
    print()
    print("Your key and the Whisper endpoint are BOTH working correctly.")
    print("If Nexus is still sounding like it's using Google fallback,")
    print("the issue is elsewhere -- share the terminal output around")
    print("your next 'hey nexus' attempt and we'll dig into it.")
except Exception as error:
    print(f"[FAIL] Groq Whisper API call failed: {error}")
    print()
    print("This confirms the voice pipeline really is falling back to")
    print("Google every time. Share this exact error message.")