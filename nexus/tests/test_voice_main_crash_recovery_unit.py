"""Unit tests for voice/main.py's crash-recovery loop (P1.11).

VoiceController/SharedMicrophone are mocked (same `sys.modules`
injection pattern as test_file_overwrite_protection.py) so this never
touches a real microphone, speech recognizer, or the `keyboard`
package (which isn't even installable in this environment) -- it only
exercises main()'s own restart/reset/terminal-failure bookkeeping.

Covers the actual defect found in this pass: `consecutive_restarts` was
never reset, so crashes spread across days of otherwise-healthy
operation were (mis)treated the same as a tight crash loop. These
tests patch `HEALTHY_RUN_SECONDS`/`RESTART_DELAY_SECONDS` down to
near-zero so they run in well under a second each, and patch
`time.sleep` so no real wall-clock delay occurs during the restart
pause itself.
"""

import sys
import types

import pytest


def _load_voice_main(run_sequence, run_duration=0.0):
    """Mocks voice.voice_controller/voice.audio_source, then imports a
    fresh copy of voice.main. `run_sequence` is a list of either
    Exception instances (controller.run() raises) or None (run()
    returns normally, i.e. an intentional stop)."""

    calls = {"run": 0, "mic_closes": 0}

    class FakeVoiceController:
        def __init__(self):
            pass

        def run(self):
            outcome = run_sequence[calls["run"]]
            calls["run"] += 1
            import time as _time
            if run_duration:
                _time.sleep(run_duration)
            if outcome is None:
                return  # intentional stop
            raise outcome

    class FakeSharedMicrophone:
        @staticmethod
        def close():
            calls["mic_closes"] += 1

    vc_module = types.ModuleType("voice.voice_controller")
    vc_module.VoiceController = FakeVoiceController
    sys.modules["voice.voice_controller"] = vc_module

    audio_module = types.ModuleType("voice.audio_source")
    audio_module.SharedMicrophone = FakeSharedMicrophone
    sys.modules["voice.audio_source"] = audio_module

    main_path = "voice.main"
    sys.modules.pop(main_path, None)
    import voice.main as voice_main  # noqa: E402

    return voice_main, calls


@pytest.fixture(autouse=True)
def _cleanup_fakes():
    yield
    for name in ("voice.voice_controller", "voice.audio_source", "voice.main"):
        sys.modules.pop(name, None)


def test_an_intentional_stop_returns_cleanly_with_no_crash_handling(monkeypatch, tmp_path):
    voice_main, calls = _load_voice_main(run_sequence=[None])
    monkeypatch.setattr(voice_main, "CRASH_LOG_PATH", tmp_path / "crash.log")
    voice_main.main()
    assert calls["run"] == 1
    assert not (tmp_path / "crash.log").exists(), "a clean stop must never write a crash log"


def test_a_single_crash_restarts_and_then_succeeds(monkeypatch, tmp_path):
    voice_main, calls = _load_voice_main(run_sequence=[RuntimeError("boom"), None])
    monkeypatch.setattr(voice_main, "CRASH_LOG_PATH", tmp_path / "crash.log")
    monkeypatch.setattr(voice_main, "RESTART_DELAY_SECONDS", 0)

    voice_main.main()

    assert calls["run"] == 2
    assert calls["mic_closes"] == 1, "a crash must force a fresh microphone stream on restart"
    assert (tmp_path / "crash.log").exists(), "a crash must be recorded, not silently swallowed"
    assert "boom" in (tmp_path / "crash.log").read_text()


def test_crashes_spread_across_healthy_runs_never_hit_the_terminal_cap(monkeypatch, tmp_path):
    """The actual defect: consecutive_restarts was never reset, so N
    crashes spread across long healthy runs eventually hit the same cap
    as N crashes in a tight loop. A run that lasts >= HEALTHY_RUN_SECONDS
    before crashing must reset the counter."""
    crash_count = 10  # more than MAX_CONSECUTIVE_RESTARTS
    run_sequence = [RuntimeError(f"boom-{i}") for i in range(crash_count)] + [None]

    voice_main, calls = _load_voice_main(run_sequence=run_sequence, run_duration=0.02)
    monkeypatch.setattr(voice_main, "CRASH_LOG_PATH", tmp_path / "crash.log")
    monkeypatch.setattr(voice_main, "RESTART_DELAY_SECONDS", 0)
    monkeypatch.setattr(voice_main, "HEALTHY_RUN_SECONDS", 0.01)  # shorter than run_duration above

    # Must NOT raise -- every crash here "ran long enough" to count as
    # healthy, so the counter resets each time and never reaches the cap.
    voice_main.main()

    assert calls["run"] == crash_count + 1


def test_a_tight_crash_loop_with_no_healthy_runs_is_treated_as_terminal_failure(monkeypatch, tmp_path):
    run_sequence = [RuntimeError(f"fast-fail-{i}") for i in range(20)]
    voice_main, calls = _load_voice_main(run_sequence=run_sequence, run_duration=0.0)
    monkeypatch.setattr(voice_main, "CRASH_LOG_PATH", tmp_path / "crash.log")
    monkeypatch.setattr(voice_main, "RESTART_DELAY_SECONDS", 0)
    monkeypatch.setattr(voice_main, "HEALTHY_RUN_SECONDS", 10)  # far longer than these instant crashes

    with pytest.raises(RuntimeError):
        voice_main.main()

    assert calls["run"] == voice_main.MAX_CONSECUTIVE_RESTARTS + 1
    log_text = (tmp_path / "crash.log").read_text()
    assert "TERMINAL FAILURE" in log_text, "exceeding the cap must be surfaced unambiguously, not just another restart line"


def test_keyboard_interrupt_stops_cleanly_without_being_treated_as_a_crash(monkeypatch, tmp_path):
    voice_main, calls = _load_voice_main(run_sequence=[KeyboardInterrupt()])
    monkeypatch.setattr(voice_main, "CRASH_LOG_PATH", tmp_path / "crash.log")

    voice_main.main()  # must return, not raise

    assert calls["run"] == 1
    assert not (tmp_path / "crash.log").exists(), "Ctrl+C is an intentional stop, not a crash to log"
