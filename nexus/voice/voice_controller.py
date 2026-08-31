import time
import threading
import keyboard
import requests

from voice.wake_word import WakeWordDetector
from voice.speech_to_text import SpeechToText
from voice.text_to_speech import TextToSpeech
from voice.lang_detect import ACK_PHRASES, detect_language, get_phrase
from voice.audio_source import SharedMicrophone
from voice.sound_cue import play_wake_beep


MCIS_COMMAND_URL = "http://localhost:5051/api/command"
MCIS_GRANT_URL = "http://localhost:5051/api/permissions/grant"
MCIS_EMERGENCY_STOP_URL = "http://localhost:5051/api/emergency/stop"
MCIS_EMERGENCY_RESUME_URL = "http://localhost:5051/api/emergency/resume"
MCIS_GOAL_STATUS_URL = "http://localhost:5051/api/command/goal/{plan_id}/status"
MCIS_GOAL_ANSWER_URL = "http://localhost:5051/api/command/goal/{plan_id}/answer"

# How often to check on a multi-step task's progress, and how long to
# keep checking before giving up and telling the user it's taking a
# long time (it may still finish -- this just stops the voice pipeline
# waiting forever if something got stuck).
PLAN_POLL_INTERVAL_SECONDS = 2
PLAN_POLL_MAX_SECONDS = 180
DEVICE_ID = "voice-listener-01"  # any identifier for this laptop's voice listener

# One retry on a dropped/failed connection to the MCIS backend before we
# tell the user it's unreachable -- covers a transient network blip
# instead of failing a whole command on the first hiccup.
COMMAND_RETRY_ATTEMPTS = 2
COMMAND_RETRY_DELAY_SECONDS = 1.0

# Below this Whisper confidence score, read the command back and confirm
# before acting on it instead of silently risking a mis-hear. Only
# applies when confidence is actually known (Whisper path) -- the Google
# fallback has no confidence signal and is never gated by this.
LOW_CONFIDENCE_THRESHOLD = 0.45

# If STT comes back empty this many times in a row, stop looping forever
# and give the user a clear way out instead of leaving them stuck talking
# to a mic that isn't hearing them.
MAX_CONSECUTIVE_EMPTY_LISTENS = 3


class VoiceController:

    def __init__(self):
        # Open the microphone once and calibrate ambient noise once, then
        # share that same stream between wake-word detection and command
        # listening for the whole run -- removes the reopen-every-call
        # latency/flakiness and the chance of the two fighting over the
        # audio device.
        shared_source = SharedMicrophone.get()
        self.wake = WakeWordDetector(source=shared_source)
        self.stt = SpeechToText(source=shared_source)
        self.tts = TextToSpeech()
        self.muted = threading.Event()
        # Set to interrupt whatever Nexus is currently saying (see
        # _speak()). This is a conservative, low-risk form of letting the
        # user cut in -- via the existing mute hotkey -- rather than full
        # continuous voice barge-in, which would need a second live audio
        # stream running during playback.
        self._speaking_interrupt = threading.Event()
        self._setup_hotkeys()

    def _setup_hotkeys(self):
        def do_mute():
            if not self.muted.is_set():
                self.muted.set()
                self._speaking_interrupt.set()  # cut off anything being said right now
                print("[HOTKEY] Ctrl+M pressed -- muted.")
                # Ctrl+M is a keyboard hotkey (not mic-based), so it still
                # fires even while the voice pipeline is blocked waiting
                # on a long-running MCIS task (e.g. "open notepad and
                # write a paragraph") -- during that wait the mic isn't
                # being read at all, so a SPOKEN "stop" wouldn't be heard.
                # This also tells MCIS to halt the in-progress multi-step
                # plan between steps, giving a real way to interrupt a
                # task that's already running, not just muting future
                # listening.
                try:
                    requests.post(MCIS_EMERGENCY_STOP_URL, timeout=5)
                except requests.exceptions.RequestException as error:
                    print(f"[HOTKEY] Could not reach MCIS to stop the current task: {error}")
                self._speak("Muted. Ctrl plus N se wapas jagao.")

        def do_unmute():
            if self.muted.is_set():
                self.muted.clear()
                print("[HOTKEY] Ctrl+N pressed -- listening resumed.")
                # Pairs with do_mute()'s emergency-stop call: unmuting
                # also tells MCIS it's safe to run automation again.
                # Without this, everything would stay blocked forever
                # after a single Ctrl+M, since emergency-stop doesn't
                # clear itself.
                try:
                    requests.post(MCIS_EMERGENCY_RESUME_URL, timeout=5)
                except requests.exceptions.RequestException as error:
                    print(f"[HOTKEY] Could not reach MCIS to resume automation: {error}")
                self._speak("Wapas sun rahi hoon.")

        try:
            keyboard.add_hotkey("ctrl+m", do_mute)
            keyboard.add_hotkey("ctrl+n", do_unmute)
        except Exception as error:
            print(f"[HOTKEY] Could not register global hotkeys: {error}")

    def _speak(self, text: str):
        """Speak through the shared TTS engine, interruptible via the
        mute hotkey (Ctrl+M)."""
        self._speaking_interrupt.clear()
        self.tts.speak(text, interrupt_event=self._speaking_interrupt)
        # Drain/discard whatever the mic picks up for a brief moment
        # right after Nexus stops talking, before we start listening
        # again -- prevents Nexus's own voice (speaker-to-mic echo) or
        # residual audio from that instant being mistaken for the next
        # command.
        SharedMicrophone.settle(0.4)

    def _is_affirmative(self, answer: str) -> bool:
        answer = (answer or "").lower().strip()
        return (
            answer == "haan" or answer == "han"
            or answer == "yes" or answer == "yeah"
            or "haan" in answer or "yes" in answer
        )

    def _confirm(self, prompt: str, lang: str = "hi") -> bool:
        self._speak(prompt + get_phrase("confirm_suffix", lang))
        print("CONFIRMATION: listening for haan/yes...")
        answer = self.stt.listen()
        print("CONFIRMATION HEARD:", repr(answer))
        return self._is_affirmative(answer)

    def _listen_command(self):
        """Capture the next spoken command. If the transcription looks
        genuinely unclear (low Whisper confidence), read it back and
        confirm before treating it as real -- skipped when confidence is
        unknown (e.g. Google fallback was used), so this never slows
        down the normal/confident case."""
        text, confidence = self.stt.listen_with_confidence()
        if not text:
            return None

        if confidence is not None and confidence < LOW_CONFIDENCE_THRESHOLD:
            lang = detect_language(text)
            self._speak(get_phrase("confirm_transcript", lang, text=text))
            answer = self.stt.listen()
            if not answer or not self._is_affirmative(answer):
                self._speak(get_phrase("discarded", lang))
                return None

        return text

    def _is_stop_listening(self, command: str) -> bool:
        command = command.lower().strip()
        # "exit"/"quit" are deliberately folded in here rather than
        # killing the process: for a real end user (via the launcher
        # scripts, not a terminal they'd know how to restart), a hard
        # process-kill from a single misheard word is a landmine --
        # they'd lose voice control with no obvious way to get it back.
        # Saying "exit"/"quit"/"sleep"/etc. now all just pause the
        # session the same way; "Hey Nexus" always brings it back.
        stop_phrases = (
            "stop listening", "sleep nexus", "go to sleep", "sleep",
            "stop listening nexus", "exit", "quit", "shutdown nexus",
        )
        # Substring match, not exact match -- "nexus stop listening please"
        # or "okay stop listening now" should still trigger this instead
        # of silently falling through to being sent to MCIS as a command.
        return any(phrase in command for phrase in stop_phrases)

    def _is_emergency_stop(self, command: str) -> bool:
        command = command.lower().strip()
        emergency_phrases = ("emergency stop", "stop stop stop", "ruk jao", "sab band karo")
        # Safety-critical -- deliberately lenient (substring match) so
        # extra words around the phrase don't stop it from firing.
        return any(phrase in command for phrase in emergency_phrases)

    def _is_resume_command(self, command: str) -> bool:
        command = command.lower().strip().rstrip(".!?")
        # Pairs with _is_emergency_stop() -- emergency-stop deliberately
        # does NOT clear itself (it's a safety brake, re-enabling should
        # be a conscious action), so there needs to be a voice-reachable
        # way to resume too, not just the Ctrl+N hotkey.
        distinctive_phrases = ("resume automation", "automation chalu karo", "sab chalu karo", "phir se shuru karo")
        if any(phrase in command for phrase in distinctive_phrases):
            return True
        # Bare "resume" is a common word that could legitimately appear
        # in unrelated commands ("resume the video", "resume my
        # download") -- only treat it as the system-resume command when
        # it's the entire utterance, not a substring match.
        return command == "resume"

    def _speak_response(self, data: dict, lang: str = "hi") -> str:
        response_type = data.get("type")

        if response_type in ("permission_required", "plan_paused"):
            return data.get("message") or get_phrase("approval_needed", lang)

        if response_type == "plan_complete":
            return get_phrase("plan_complete", lang, detail=data.get("message") or "")

        if response_type in ("plan_error", "plan_stopped"):
            return data.get("message") or get_phrase("plan_error", lang)

        if response_type == "chat":
            return data.get("message") or get_phrase("chat_fallback", lang)

        if response_type == "nexus_action":
            result = data.get("result", {})
            if result.get("success"):
                return get_phrase("done", lang)
            return get_phrase("not_done_detail", lang, detail=result.get("error", "") or "")

        if response_type == "action":
            result = data.get("result", {})
            if isinstance(result, dict) and result.get("success"):
                return get_phrase("done", lang)
            return get_phrase("tried_unsure", lang)

        if response_type == "ai_task":
            return get_phrase("ai_task_done", lang)

        if response_type == "productivity":
            return "Done." if lang == "en" else "Done."

        if "error" in data:
            return get_phrase("error_generic", lang, detail=data["error"])

        return get_phrase("done", lang)

    def _post_command(self, command: str):
        last_error = None
        for attempt in range(1, COMMAND_RETRY_ATTEMPTS + 1):
            try:
                response = requests.post(
                    MCIS_COMMAND_URL,
                    json={"message": command, "deviceId": DEVICE_ID},
                    timeout=60,
                )
                return response.json()
            except requests.exceptions.ConnectionError as error:
                # Transient network blip -- worth one quick retry before
                # giving up and telling the user MCIS is unreachable.
                last_error = error
                if attempt < COMMAND_RETRY_ATTEMPTS:
                    print(f"[Nexus Voice] MCIS connection attempt {attempt} failed, retrying...")
                    time.sleep(COMMAND_RETRY_DELAY_SECONDS)
        raise last_error

    def _ask_clarification(self, question: str, lang: str) -> str | None:
        """Speak a mid-task clarifying question (e.g. 'which file did you
        mean?') and return the user's free-form spoken answer -- unlike
        _confirm(), this isn't a yes/no gate, so it just returns whatever
        was heard."""
        self._speak(question)
        answer = self.stt.listen()
        print("CLARIFICATION HEARD:", repr(answer))
        return answer

    def _poll_plan(self, plan_id: str, lang: str) -> str:
        """A multi-step task ('open notepad, write an essay, save it')
        runs in the background on the MCIS side -- the initial request
        only confirms it STARTED, not that it finished. Without this,
        Nexus would say 'Done' the instant the task begins, long before
        Notepad has even opened. This polls for the actual outcome and
        only responds once the task genuinely completes, needs approval
        for a sensitive step, needs a clarifying answer, or fails."""
        status_url = MCIS_GOAL_STATUS_URL.format(plan_id=plan_id)
        elapsed = 0.0

        while elapsed < PLAN_POLL_MAX_SECONDS:
            time.sleep(PLAN_POLL_INTERVAL_SECONDS)
            elapsed += PLAN_POLL_INTERVAL_SECONDS

            try:
                response = requests.get(status_url, timeout=15)
                snapshot = response.json()
            except requests.exceptions.RequestException as error:
                print(f"[Nexus Voice] Plan status check failed, retrying: {error}")
                continue

            status = snapshot.get("status")

            if status == "completed" or status == "error" or status == "stopped":
                result = snapshot.get("result") or {}
                return self._speak_response(result, lang)

            if status == "paused":
                pending = snapshot.get("pendingStep") or {}
                action_name = pending.get("action", "this step")
                approved = self._confirm(
                    get_phrase("approval_needed", lang) + f" ({action_name})",
                    lang=lang,
                )
                if not approved:
                    return get_phrase("cancelled", lang)
                try:
                    requests.post(MCIS_GRANT_URL, json={"resource": f"plan:{plan_id}"}, timeout=60)
                except requests.exceptions.RequestException as error:
                    print("GRANT ERROR:", error)
                    return get_phrase("grant_failed", lang)
                continue  # keep polling after resuming

            if status == "awaiting_clarification":
                question = snapshot.get("pendingQuestion") or get_phrase("chat_fallback", lang)
                answer = self._ask_clarification(question, lang)
                try:
                    answer_url = MCIS_GOAL_ANSWER_URL.format(plan_id=plan_id)
                    requests.post(answer_url, json={"answer": answer or ""}, timeout=15)
                except requests.exceptions.RequestException as error:
                    print("CLARIFICATION SUBMIT ERROR:", error)
                    return get_phrase("connection_failed", lang)
                continue  # keep polling after answering

            # status == "running" (or anything unrecognized) -- keep waiting.

        # Timed out waiting -- the task may still finish on its own, but
        # don't leave the user hanging indefinitely.
        return get_phrase("plan_error", lang)

    def _send_to_mcis(self, command: str, lang: str = "hi", data: dict | None = None) -> str:
        try:
            if data is None:
                data = self._post_command(command)
            print("MCIS RESPONSE:", data)

            if data.get("type") == "plan_started" and data.get("planId"):
                return self._poll_plan(data["planId"], lang)

            while data.get("type") in ("permission_required", "plan_paused"):
                resource = data.get("resource", "this")
                approved = self._confirm(
                    data.get("message", f"Approve access to {resource}?"),
                    lang=lang,
                )

                if not approved:
                    return get_phrase("cancelled", lang)
                try:
                    grant_res = requests.post(
                        MCIS_GRANT_URL,
                        json={"resource": resource},
                        timeout=60,
                    )
                    grant_res.raise_for_status()
                    data = grant_res.json()
                    print("MCIS GRANT/RESUME RESPONSE:", data)
                except requests.exceptions.RequestException as error:
                    print("GRANT ERROR:", error)
                    return get_phrase("grant_failed", lang)
            return self._speak_response(data, lang)
        except requests.exceptions.RequestException as error:
            print("MCIS CONNECTION ERROR:", error)
            return get_phrase("connection_failed", lang)

    def _dispatch_command(self, command: str, lang: str) -> str:
        """Speak the acknowledgment phrase WHILE the initial MCIS request
        runs in a background thread, instead of waiting for the ack to
        finish speaking before even starting the network call. This
        overlaps the two, so the total time before the user hears a real
        result is roughly max(ack duration, network time) instead of
        ack duration + network time -- a real, meaningful chunk of the
        time-to-response for the common case.

        The background thread ONLY makes the HTTP request (no TTS, no
        mic access), so there's no contention with the ack speech. Once
        both are done, everything else (including any permission-confirm
        back-and-forth) runs single-threaded exactly as before -- that
        part genuinely can't be overlapped safely since it needs the mic
        and TTS itself.
        """
        result_holder = {}

        def _fetch():
            try:
                result_holder["data"] = self._post_command(command)
            except requests.exceptions.RequestException as error:
                result_holder["error"] = error

        worker = threading.Thread(target=_fetch, daemon=True)
        worker.start()

        ack_phrase = ACK_PHRASES.get(lang, ACK_PHRASES["hi"])
        self._speak(ack_phrase)

        worker.join()

        if "error" in result_holder:
            print("MCIS CONNECTION ERROR:", result_holder["error"])
            return get_phrase("connection_failed", lang)

        return self._send_to_mcis(command, lang, data=result_holder.get("data"))

    def run(self):
        print("Nexus Voice Started...")
        while True:
            print("Waiting for wake word...")

            if self.muted.is_set():
                self.muted.wait()

            try:
                heard_wake, trailing_command = self.wake.wait_with_command()
                if not heard_wake:
                    continue
            except KeyboardInterrupt:
                break
            except Exception as error:
                # Nothing from the mic/STT layer should ever be able to
                # kill the whole voice process -- log it and just retry
                # waiting for the wake word instead of exiting.
                print(f"[Nexus Voice] Unexpected error while waiting for wake word, retrying: {error}")
                continue

            command = trailing_command.strip() if trailing_command else None

            if command:
                print("USER (with wake word):", command)
            else:
                # No command was bundled with the wake word -- cue the
                # user that we're now actively listening before we start
                # the (blocking) capture, so they know exactly when to
                # start talking instead of guessing.
                play_wake_beep()
                print("Nexus is listening...")

            consecutive_empty_listens = 0

            while True:
                if self.muted.is_set():
                    command = None
                    break

                if not command:
                    try:
                        command = self._listen_command()
                    except KeyboardInterrupt:
                        return
                    except Exception as error:
                        # Same principle as above -- an unexpected error
                        # here (mic glitch, transcription API hiccup,
                        # anything) should degrade to "didn't hear
                        # anything" and keep the session alive, never
                        # silently kill the whole process.
                        print(f"[Nexus Voice] Unexpected error while listening for a command: {error}")
                        command = None

                    if not command:
                        consecutive_empty_listens += 1
                        if consecutive_empty_listens >= MAX_CONSECUTIVE_EMPTY_LISTENS:
                            # Genuine sustained silence (several attempts
                            # in a row heard nothing) -- let the wake-word
                            # requirement come back instead of listening
                            # forever. Until this point, though, the mic
                            # keeps actively retrying (continuity) rather
                            # than giving up after a single missed beat.
                            self._speak(get_phrase("trouble_hearing", "hi"))
                            command = None
                            break
                        self._speak(get_phrase("retry", "hi"))
                        continue

                    consecutive_empty_listens = 0
                    print("USER :", command)

                    # If the user just repeated the wake word mid-session
                    # (e.g. said "Hey Nexus" again to get our attention
                    # after a mix-up), don't send "hey nexus" itself to
                    # MCIS as if it were the actual command -- treat it as
                    # "I'm still here" and keep listening for the real
                    # command instead. If they bundled a real command with
                    # it ("hey nexus open chrome"), use just that part.
                    variant = self.wake._find_wake_variant(command.lower())
                    if variant:
                        idx = command.lower().find(variant)
                        trailing = command[idx + len(variant):].strip()
                        if not self.wake._has_real_content(trailing):
                            play_wake_beep()
                            command = None
                            continue
                        command = trailing

                lang = detect_language(command)

                if self._is_resume_command(command):
                    try:
                        requests.post(MCIS_EMERGENCY_RESUME_URL, timeout=10)
                    except requests.exceptions.RequestException as error:
                        print("RESUME REQUEST ERROR:", error)
                    self._speak(get_phrase("resumed", lang))
                    command = None
                    continue

                if self._is_emergency_stop(command):
                    try:
                        requests.post(MCIS_EMERGENCY_STOP_URL, timeout=10)
                    except requests.exceptions.RequestException as error:
                        print("EMERGENCY STOP REQUEST ERROR:", error)
                    self._speak(get_phrase("emergency_stop", lang))
                    command = None
                    continue

                if self._is_stop_listening(command):
                    self._speak(get_phrase("sleep", lang))
                    command = None
                    break

                response_text = self._dispatch_command(command, lang)
                print("MCIS:", response_text)
                self._speak(response_text)
                command = None