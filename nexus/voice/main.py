import time
import traceback
from pathlib import Path

from dotenv import load_dotenv
from voice.voice_controller import VoiceController
from voice.audio_source import SharedMicrophone

# If the voice loop ever crashes despite all the internal safety nets,
# rebuild the controller and start it again instead of the whole
# process just dying -- with a short pause so a persistent failure
# doesn't spin the CPU in a tight crash loop.
MAX_CONSECUTIVE_RESTARTS = 5
RESTART_DELAY_SECONDS = 2

# P1.11 -- "consecutive" previously meant "ever, across this process's
# entire lifetime" rather than genuinely consecutive: the counter was
# never reset, so five unrelated crashes spread across days or weeks
# of otherwise-healthy operation would eventually hit the same cap as
# five crashes in rapid succession, and the process would permanently
# give up even though nothing was actually wrong at the time. A run
# that stays up for at least this long is healthy enough to reset the
# counter -- only genuinely repeated, close-together failures should
# count as "too many in a row."
HEALTHY_RUN_SECONDS = 60

# Crash diagnostics -- previously a crash only ever printed a single
# line (`str(error)`, no traceback) to stdout, which is lost the moment
# nothing happens to be watching that terminal (a background service, a
# crashed terminal window, a machine that's since been restarted).
# Every crash and the final terminal-failure message are now also
# appended here, so "what actually happened" survives even when no one
# saw it happen live.
CRASH_LOG_PATH = Path(__file__).resolve().parent.parent / "nexus_voice_crash.log"


def _log_crash(message: str) -> None:
    print(message)
    try:
        with open(CRASH_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(f"\n{'=' * 70}\n{time.strftime('%Y-%m-%d %H:%M:%S')}\n{message}\n")
    except Exception as log_error:
        # Diagnostics must never themselves be the reason the process
        # dies in a confusing way -- if we can't write the log, say so
        # on stdout and carry on with the restart/terminal-failure logic.
        print(f"[Nexus Voice] (could not write crash log: {log_error})")


def main():

    # Load nexus/.env (GROQ_API_KEY, NEXUS_DEVICE_TOKEN, etc.) into the
    # process environment. Without this, transcription.py's
    # os.getenv("GROQ_API_KEY") never sees the key even if it's sitting
    # right there in .env -- the voice pipeline would silently fall back
    # to Google every time with no visible error.
    load_dotenv()

    consecutive_restarts = 0

    while True:
        run_started_at = time.monotonic()
        try:
            controller = VoiceController()
            controller.run()
            # run() only returns normally on "exit"/"quit" or Ctrl+C
            # inside it -- either way, that's an intentional stop.
            break
        except KeyboardInterrupt:
            break
        except Exception as error:
            ran_for = time.monotonic() - run_started_at
            if ran_for >= HEALTHY_RUN_SECONDS:
                # This run was healthy for a while before failing --
                # treat it as a fresh start, not another link in a
                # crash-loop chain.
                consecutive_restarts = 0
            consecutive_restarts += 1

            _log_crash(
                f"[Nexus Voice] Voice pipeline crashed after {ran_for:.1f}s "
                f"(consecutive failure #{consecutive_restarts}): {error}\n"
                f"{traceback.format_exc()}"
            )

            if consecutive_restarts > MAX_CONSECUTIVE_RESTARTS:
                _log_crash(
                    "[Nexus Voice] TERMINAL FAILURE: "
                    f"{consecutive_restarts} consecutive crashes with no healthy "
                    f"run of {HEALTHY_RUN_SECONDS}s+ in between -- stopping instead "
                    "of restarting forever. This is NOT a transient recovery; the "
                    "voice pipeline is down until someone investigates the error "
                    f"above (also saved to {CRASH_LOG_PATH}) and restarts it."
                )
                raise
            # Force a fresh microphone stream on the next start, in case
            # the crash was caused by the audio device itself going bad
            # -- reusing a broken stream handle would just crash again
            # immediately.
            SharedMicrophone.close()
            print(
                f"[Nexus Voice] Restarting voice pipeline in {RESTART_DELAY_SECONDS}s "
                f"(treating this as temporary recovery, {MAX_CONSECUTIVE_RESTARTS - consecutive_restarts} "
                "more consecutive failures tolerated before giving up)..."
            )
            time.sleep(RESTART_DELAY_SECONDS)


if __name__ == "__main__":

    main()
