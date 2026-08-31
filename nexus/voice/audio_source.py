"""
Shared microphone stream for the Nexus voice pipeline.

Previously, WakeWordDetector and SpeechToText each opened a brand new
`sr.Microphone()` (a fresh PyAudio stream) on every single listen() call,
with no ambient-noise calibration. That meant:
  - extra device open/close latency on every loop iteration
  - the very first "Hey Nexus" / first command after startup racing a
    cold-started audio device
  - a fixed, guessed energy_threshold instead of one calibrated to the
    room

This module opens the microphone ONCE, calibrates ambient noise once,
and keeps the stream alive for the lifetime of the process. Both
WakeWordDetector and SpeechToText use the same open stream sequentially
(they are never listening at the same time), which also removes any
chance of the two fighting over the audio device.

Nothing here changes recognition behavior/back end -- it only changes
when the device is opened.
"""

import time

import speech_recognition as sr


class SharedMicrophone:
    _source = None
    _calibrated = False

    @classmethod
    def get(cls):
        """Return the single shared, already-open microphone source."""
        if cls._source is None:
            mic = sr.Microphone()
            mic.__enter__()  # opens the PyAudio stream and keeps it open
            cls._source = mic

            if not cls._calibrated:
                try:
                    calibrator = sr.Recognizer()
                    calibrator.adjust_for_ambient_noise(mic, duration=1)
                except Exception as error:
                    print(f"[Nexus Voice] Ambient noise calibration skipped: {error}")
                cls._calibrated = True

        return cls._source

    @classmethod
    def settle(cls, seconds: float = 0.4):
        """Briefly drain and discard whatever audio the mic picks up for
        the next `seconds`. Call this right after Nexus finishes
        speaking, before listening for the next command -- otherwise
        acoustic echo/tail from Nexus's own voice (speaker bleeding into
        the mic) or residual audio from that moment can get captured and
        mistaken for something the user said."""
        source = cls._source
        if source is None or getattr(source, "stream", None) is None:
            time.sleep(seconds)
            return
        end_time = time.time() + seconds
        try:
            while time.time() < end_time:
                source.stream.read(source.CHUNK, exception_on_overflow=False)
        except Exception:
            # If the drain read fails for any reason, fall back to a
            # plain pause -- never let this raise into the caller.
            remaining = end_time - time.time()
            if remaining > 0:
                time.sleep(remaining)

    @classmethod
    def close(cls):
        """Release the microphone stream (used on shutdown / by tests)."""
        if cls._source is not None:
            try:
                cls._source.__exit__(None, None, None)
            except Exception:
                pass
            cls._source = None
            cls._calibrated = False