import requests

from voice.wake_word import WakeWordDetector
from voice.speech_to_text import SpeechToText
from voice.text_to_speech import TextToSpeech


MCIS_COMMAND_URL = "http://localhost:5051/api/command"
MCIS_GRANT_URL = "http://localhost:5051/api/permissions/grant"
MCIS_EMERGENCY_STOP_URL = "http://localhost:5051/api/emergency/stop"
DEVICE_ID = "voice-listener-01"  # any identifier for this laptop's voice listener


class VoiceController:

    def __init__(self):

        self.wake = WakeWordDetector()
        self.stt = SpeechToText()
        self.tts = TextToSpeech()

    def _confirm(self, prompt: str) -> bool:

        self.tts.speak(prompt + " Haan ya nahi boliye.")
        print("CONFIRMATION: listening for haan/yes...")
        answer = self.stt.listen()
        print("CONFIRMATION HEARD:", repr(answer))

        if not answer:
            return False

        answer = answer.lower().strip()
        return (
            answer == "haan" or answer == "han"
            or answer == "yes" or answer == "yeah"
            or "haan" in answer or "yes" in answer
        )

    def _is_stop_listening(self, command: str) -> bool:
        command = command.lower().strip()
        stop_words = ("stop listening", "sleep nexus", "go to sleep", "sleep", "stop listening nexus")
        return command in stop_words

    def _is_exit(self, command: str) -> bool:
        command = command.lower().strip()
        return command in ("exit", "quit", "shutdown nexus")

    def _is_emergency_stop(self, command: str) -> bool:
        command = command.lower().strip()
        return command in ("emergency stop", "stop stop stop", "ruk jao", "sab band karo")

    def _detect_ack_phrase(self, command: str) -> str:
        """Pick a short acknowledgment phrase matching the language the user just spoke in."""
        text = command.strip()

        # Devanagari script present -> Hindi
        if any('\u0900' <= ch <= '\u097F' for ch in text):
            return "मैं कर रही हूँ।"

        # Common Hinglish/Hindi words written in Roman script
        hinglish_words = {"kholo", "khol", "karo", "kar", "do", "hai", "chahiye", "aur", "wala", "wali"}
        words = set(text.lower().split())
        if words & hinglish_words:
            return "Kar rahi hoon."

        # Default: English
        return "Working on it."

    def _speak_response(self, data: dict) -> str:
        """Turn MCIS's /api/command JSON response into a spoken sentence."""
        response_type = data.get("type")

        if response_type in ("permission_required", "plan_paused"):
            return data.get("message", "Isse karne ke liye pehle approval chahiye.")

        if response_type == "plan_complete":
            return "Poora kaam ho gaya. " + (data.get("message") or "")

        if response_type in ("plan_error", "plan_stopped"):
            return data.get("message", "Kaam poora nahi ho paya.")

        if response_type == "chat":
            return data.get("message", "Samjha nahi, dobara boliye.")

        if response_type == "nexus_action":
            result = data.get("result", {})
            if result.get("success"):
                return "Ho gaya."
            return f"Nahi ho paya. {result.get('error', '')}"

        if response_type == "action":
            result = data.get("result", {})
            if isinstance(result, dict) and result.get("success"):
                return "Ho gaya."
            return "Try to kiya, par confirm nahi hai."

        if response_type == "ai_task":
            return "Ho gaya, tumhara task complete hai."

        if response_type == "productivity":
            return "Done."

        if "error" in data:
            return f"Error aaya: {data['error']}"

        return "Ho gaya."

    def _post_command(self, command: str):
        response = requests.post(
            MCIS_COMMAND_URL,
            json={"message": command, "deviceId": DEVICE_ID},
            timeout=60,
        )
        return response.json()

    def _send_to_mcis(self, command: str) -> str:
        try:
            data = self._post_command(command)
            print("MCIS RESPONSE:", data)

            # Loop: keep confirming + resuming until the task finishes,
            # fails, or the user declines a confirmation. Handles both
            # simple permission_required (single action) and plan_paused
            # (multi-step goal waiting mid-way for approval).
            while data.get("type") in ("permission_required", "plan_paused"):
                resource = data.get("resource", "this")
                approved = self._confirm(
                    data.get("message", f"Approve access to {resource}?")
                )

                if not approved:
                    return "Theek hai, cancel kar diya."

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
                    return "Approval save nahi ho payi, dobara try karo."

            return self._speak_response(data)

        except requests.exceptions.RequestException as error:
            print("MCIS CONNECTION ERROR:", error)
            return "MCIS backend se connect nahi ho paya. Check karo ki backend chal raha hai."

    def run(self):

        print("Nexus Voice Started...")

        while True:

            print("Waiting for wake word...")

            try:
                if not self.wake.wait():
                    continue
            except KeyboardInterrupt:
                break

            self.tts.speak("Yes?")
            print("Nexus is listening...")

            while True:

                try:
                    command = self.stt.listen()
                except KeyboardInterrupt:
                    return

                if not command:
                    self.tts.speak("Sorry, I didn't catch that.")
                    continue

                print("USER :", command)

                # --------------------------------
                # EMERGENCY STOP — highest priority, checked before anything else
                # --------------------------------

                if self._is_emergency_stop(command):
                    try:
                        requests.post(MCIS_EMERGENCY_STOP_URL, timeout=10)
                    except requests.exceptions.RequestException as error:
                        print("EMERGENCY STOP REQUEST ERROR:", error)
                    self.tts.speak("Emergency stop. Sab ruk gaya.")
                    continue

                if self._is_exit(command):
                    self.tts.speak("Goodbye.")
                    return

                if self._is_stop_listening(command):
                    self.tts.speak("Okay. Main sleep mode mein ja rahi hoon.")
                    break

                self.tts.speak(self._detect_ack_phrase(command))
                response_text = self._send_to_mcis(command)
                print("MCIS:", response_text)
                self.tts.speak(response_text)