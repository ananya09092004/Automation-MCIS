import json

from voice.intent_router import IntentRouter
from voice.llm_chat import NexusLLM
from common import ExecutionAction, ExecutionResult, default_capabilities


class ActionPlanningError(Exception):
    """Raised when the command could not be turned into a valid action."""


class NexusController:

    def __init__(self, confirm_callback=None):

        self.router = IntentRouter()

        self.llm = NexusLLM()

        self.execution_gateway = None
        self.capabilities = default_capabilities()

        # Optional Callable[[str], bool] supplied by the voice layer so this
        # controller can ask "do you approve?" out loud before a high-risk
        # action (delete, pay, login, submit, ...) runs, without this class
        # needing to know anything about microphones/speakers itself.
        self.confirm_callback = confirm_callback

    def execute_action(self, action: dict) -> ExecutionResult:
        """Execute an already-planned action from the partner orchestrator."""
        if self.execution_gateway is None:
            from execution_gateway import ExecutionGateway
            self.execution_gateway = ExecutionGateway()
        return self.execution_gateway.execute(action)

    def handle(self, command: str) -> str:

        intent = self.router.route(command)

        # -------------------------
        # Normal conversation
        # -------------------------

        if intent.category == "chat":

            return self.llm.ask(command)

        # -------------------------
        # Browser / Desktop -> plan real ExecutionAction(s) and run them
        # -------------------------

        if intent.category in ("browser", "desktop"):

            return self._handle_task(command)

        return self.llm.ask(command)

    def _handle_task(self, command: str) -> str:
        try:
            actions = self._plan_actions(command)
        except ActionPlanningError:
            # Could not confidently turn this into a safe, supported
            # action. Never guess-execute -- fall back to a normal
            # conversational answer instead (matches the "safe structured
            # failure, never random clicking" rule the execution layer
            # already follows).
            return self.llm.ask(command)

        if not actions:
            return self.llm.ask(command)

        spoken_parts = []
        for action in actions:
            if action.get("action") == "ai_edit_document":
                spoken_parts.append(self._ai_edit_document(action))
            else:
                spoken_parts.append(self._execute_with_confirmation(action))
        return " ".join(spoken_parts)

    def _ai_edit_document(self, action: dict) -> str:
        """Universal 'change this file however I describe' flow: resolve
        the file (searching common personal folders if just a name was
        given, not a full path), read it, ask the LLM to propose the full
        new content plus a short summary, speak the summary and get voice
        confirmation, then write it back. Works for any format
        desktop/document_io.py supports (txt, docx, pdf-read, xlsx).
        """
        given_path = action.get("parameters", {}).get("path") or action.get("target", {}).get("path")
        instruction = action.get("value") or ""

        if not given_path:
            return "Konsi file, yeh clear nahi hua -- naam ya path bata ke dobara bolo."

        path = self._resolve_document_path(given_path)
        if path is None:
            return f"'{given_path}' naam ki koi file mujhe kahin nahi mili."
        if isinstance(path, list):
            preview = ", ".join(path[:5])
            return f"'{given_path}' naam se {len(path)} files mili -- {preview}. Poora path bata ke dobara bolo."

        read_result = self.execute_action(
            {"platform": "desktop", "action": "read_document", "parameters": {"path": path}}
        )
        if not read_result.success:
            return f"{path} nahi padh paya -- {read_result.error or read_result.message}"

        try:
            proposal = self._propose_document_edit(read_result.data, instruction)
        except ActionPlanningError as error:
            return f"Changes propose nahi kar paya -- {error}"

        approved = bool(self.confirm_callback) and self.confirm_callback(
            f"{path} mein yeh changes karne wala hun -- {proposal['summary']}. Kya main save kar du?"
        )
        if not approved:
            return "Theek hai, changes save nahi kiye."

        write_result = self.execute_action({
            "platform": "desktop",
            "action": "write_document",
            "parameters": {"path": path},
            "value": proposal["new_content"],
            "approval_token": "user_voice_confirmed",
        })
        if not write_result.success:
            return f"Save nahi ho paya -- {write_result.error or write_result.message}"
        return f"{path} update kar diya -- {proposal['summary']}"

    def _resolve_document_path(self, given_path: str):
        """Return the file's real path if it already exists as given,
        else search common personal folders for a matching filename.
        Returns None (not found), a str (exactly one match), or a list
        of str (ambiguous -- more than one match, caller must ask)."""
        import os
        if os.path.isfile(given_path):
            return given_path

        find_result = self.execute_action(
            {"platform": "desktop", "action": "find_document", "parameters": {"query": given_path}}
        )
        if not find_result.success:
            return None
        matches = find_result.data or []
        if not matches:
            return None
        if len(matches) == 1:
            return matches[0]
        return matches

    def _propose_document_edit(self, current_content: str, instruction: str) -> dict:
        prompt = f"""You are editing an existing document. Given its current content and the user's instruction, propose the FULL new content (not a diff/patch) plus a short one-sentence summary of what you changed.

Reply with ONLY a JSON object of the form: {{"summary": "...", "new_content": "..."}}
No markdown fences, no explanation outside the JSON.

Current content:
---
{current_content}
---

User's instruction: {instruction}"""

        try:
            raw = self.llm.client.chat.completions.create(
                model="llama-3.3-70b-versatile",
                messages=[{"role": "user", "content": prompt}],
                temperature=0.3,
                max_tokens=4000,
            )
            text = raw.choices[0].message.content.strip()
            text = text.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
            payload = json.loads(text)
        except Exception as error:
            raise ActionPlanningError(str(error)) from error

        if "new_content" not in payload or "summary" not in payload:
            raise ActionPlanningError("LLM response missing summary/new_content")
        return payload

    def _execute_with_confirmation(self, action: dict) -> str:
        result = self.execute_action(action)

        if not result.success and result.message == "Action blocked pending user approval.":
            description = self._describe_action(action)
            approved = bool(self.confirm_callback) and self.confirm_callback(
                f"{description} karne se pehle confirm karo -- kya main aage badhu?"
            )
            if not approved:
                return f"Theek hai, maine {description} nahi kiya -- approval nahi mila."
            action = dict(action)
            action["approval_token"] = "user_voice_confirmed"
            result = self.execute_action(action)

        return self._describe_result(action, result)

    def _plan_actions(self, command: str) -> list[dict]:
        """Ask the LLM to translate free text into one or more
        ExecutionAction dicts, restricted to the platform/action names the
        execution layer actually supports (common.default_capabilities()).

        This is a deliberately small, single-turn translator -- it is not
        the multi-step research/planning "Brain" (that is a separate,
        larger piece of work). It only maps a clear, immediate instruction
        ("notepad kholo", "google.com kholo aur python search karo") onto
        real actions this execution layer can run and verify.
        """
        catalog = self.capabilities.list()
        catalog_text = "\n".join(
            f"- platform={item['platform']} action={item['action']} :: {item['description']}"
            for item in catalog
        )

        prompt = f"""Convert the user's instruction into a JSON object of the form:
{{"actions": [{{"platform": "desktop"|"browser", "action": "<one of the action names below>", "value": <string or null>, "target": {{}}, "parameters": {{}}}}]}}

Only use platform/action pairs from this exact list -- never invent a new one:
{catalog_text}
- platform=desktop action=ai_edit_document :: Use this whenever the user wants an EXISTING file's content changed/improved/rewritten by AI (resumes, reports, notes, code, any document) -- not for creating a brand-new file. Requires "parameters": {{"path": "<file path or name the user gave>"}} and "value": "<the user's edit instruction, in their own words>". Only emit this if a clear file path/name was given; otherwise leave it out.

Rules:
- Reply with ONLY the JSON object, nothing else -- no explanation, no markdown fences.
- If the instruction is not a clear, executable desktop/browser task (e.g. it's a question, or too vague to act on safely), reply with exactly: {{"actions": []}}
- Prefer the smallest number of actions that accomplishes what was asked.
- Most actions take one piece of info via "value" (e.g. open_app just needs the app name).
- Some actions need MORE than one piece of info -- put those into "target" with these exact key names:
  copy_file/move_file/copy_folder/move_folder -> {{"source": "...", "destination": "..."}}
  rename_file/rename_folder -> {{"source": "...", "new_name": "..."}}
  search_file/search_folder -> {{"directory": "...", "query": "..."}}
  move_mouse/drag_mouse -> {{"x": <int>, "y": <int>}}
  notify -> {{"title": "...", "message": "..."}}
  hotkey -> {{"keys": ["ctrl", "c"]}}
  kill_process -> {{"process_name": "..."}}
  restart_process -> {{"process_name": "...", "command": "..."}}

User instruction: {command}"""

        try:
            raw = self.llm.client.chat.completions.create(
                model="llama-3.3-70b-versatile",
                messages=[{"role": "user", "content": prompt}],
                temperature=0,
                max_tokens=400,
            )
            text = raw.choices[0].message.content.strip()
            text = text.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
            payload = json.loads(text)
        except Exception as error:
            raise ActionPlanningError(str(error)) from error

        actions = payload.get("actions", [])
        for action in actions:
            name = action.get("action", "")
            if name == "ai_edit_document":
                if not action.get("parameters", {}).get("path"):
                    raise ActionPlanningError("ai_edit_document requires parameters.path")
                continue
            if not self.capabilities.supports(action.get("platform", ""), name):
                raise ActionPlanningError(
                    f"Unsupported platform/action: {action.get('platform')}/{name}"
                )
        return actions

    @staticmethod
    def _describe_action(action: dict) -> str:
        action_name = action.get("action", "this action")
        value = action.get("value")
        return f"{action_name}" + (f" ({value})" if value else "")

    @staticmethod
    def _describe_result(action: dict, result: ExecutionResult) -> str:
        description = NexusController._describe_action(action)
        if result.success:
            return f"{description} ho gaya."
        return f"{description} nahi ho paya -- {result.error or result.message}"
