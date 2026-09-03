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


# Fallback energy_threshold used until real calibration has run (or if
# calibration fails). This is only ever a starting guess.
_DEFAULT_ENERGY_THRESHOLD = 300


class SharedMicrophone:
    _source = None
    _calibrated = False
    # NOTE: this used to be computed and then thrown away -- calibration
    # ran on a throwaway sr.Recognizer() whose energy_threshold never
    # reached WakeWordDetector or SpeechToText, which each built their
    # own Recognizer hardcoded to 300. That meant the room calibration
    # had zero effect: on a quiet room where the real noise floor is
    # e.g. 120, or a noisy one where it's e.g. 600, everything still ran
    # at the generic guess of 300 -- one of the drivers of both missed
    # speech starts and "heard something" on plain background noise.
    # This value is now saved here so every recognizer built afterwards
    # can pick up the real calibrated number.
    _energy_threshold = _DEFAULT_ENERGY_THRESHOLD

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
                    cls._energy_threshold = calibrator.energy_threshold
                    print(f"[Nexus Voice] Mic calibrated, energy_threshold={cls._energy_threshold:.0f}")
                except Exception as error:
                    print(f"[Nexus Voice] Ambient noise calibration skipped, using default: {error}")
                cls._calibrated = True

        return cls._source

    @classmethod
    def get_energy_threshold(cls) -> float:
        """The room-calibrated energy_threshold (or the generic default
        if calibration hasn't run yet/failed). Every Recognizer built
        for the shared mic should seed itself from this instead of
        hardcoding a guessed constant."""
        return cls._energy_threshold

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
            cls._energy_threshold = _DEFAULT_ENERGY_THRESHOLD