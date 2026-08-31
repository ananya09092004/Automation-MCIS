import time

from dotenv import load_dotenv
from voice.voice_controller import VoiceController
from voice.audio_source import SharedMicrophone

# If the voice loop ever crashes despite all the internal safety nets,
# rebuild the controller and start it again instead of the whole
# process just dying -- with a short pause so a persistent failure
# doesn't spin the CPU in a tight crash loop.
MAX_CONSECUTIVE_RESTARTS = 5
RESTART_DELAY_SECONDS = 2


def main():

    # Load nexus/.env (GROQ_API_KEY, NEXUS_DEVICE_TOKEN, etc.) into the
    # process environment. Without this, transcription.py's
    # os.getenv("GROQ_API_KEY") never sees the key even if it's sitting
    # right there in .env -- the voice pipeline would silently fall back
    # to Google every time with no visible error.
    load_dotenv()

    consecutive_restarts = 0

    while True:
        try:
            controller = VoiceController()
            controller.run()
            # run() only returns normally on "exit"/"quit" or Ctrl+C
            # inside it -- either way, that's an intentional stop.
            break
        except KeyboardInterrupt:
            break
        except Exception as error:
            consecutive_restarts += 1
            print(f"[Nexus Voice] Voice pipeline crashed unexpectedly: {error}")
            if consecutive_restarts > MAX_CONSECUTIVE_RESTARTS:
                print(
                    "[Nexus Voice] Too many crashes in a row -- stopping instead of "
                    "restarting forever. Check the error above and your mic/audio setup."
                )
                raise
            # Force a fresh microphone stream on the next start, in case
            # the crash was caused by the audio device itself going bad
            # -- reusing a broken stream handle would just crash again
            # immediately.
            SharedMicrophone.close()
            print(f"[Nexus Voice] Restarting voice pipeline in {RESTART_DELAY_SECONDS}s...")
            time.sleep(RESTART_DELAY_SECONDS)


if __name__ == "__main__":

    main()