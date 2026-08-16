"""Safe, generic Playwright action executor used by the orchestrator."""

from pathlib import Path
from typing import Any

from common import ApprovalGate, ExecutionAction, ExecutionResult
from browser.controller import BrowserController
from browser.observation import PageObserver
from browser.session_store import BrowserSessionStore
from browser.recovery import BrowserRecovery
from browser.skills.infinite_scroll import InfiniteScrollSkill
from browser.skills.pagination import PaginationSkill
from browser.skills.table_reader import TableReaderSkill
from browser.verifier.verifier import BrowserVerifier


class BrowserPlatformExecutor:
    def __init__(self, approval_gate: ApprovalGate | None = None, controller: BrowserController | None = None):
        self.approval_gate = approval_gate or ApprovalGate()
        self.controller = controller or BrowserController()
        self.observer = PageObserver()
        self.sessions = BrowserSessionStore()
        self.recovery = BrowserRecovery()

    def start(self, browser: str = "chromium", headless: bool = False,
              storage_state_path: str | None = None) -> None:
        if self.controller.page is None:
            self.controller.start(browser=browser, headless=headless, storage_state_path=storage_state_path)

    def stop(self) -> None:
        if self.controller.page is not None:
            self.controller.stop()

    def _ensure_page_alive(self) -> None:
        """If the page/context/browser died between calls (crash, manual close,
        navigation failure), self.controller.page can still hold a stale
        reference. Detect that and clear it so start() creates a fresh session
        instead of every future call failing with 'page/context has been closed'."""
        try:
            if self.controller.page is not None and self.controller.page.is_closed():
                self.controller.page = None
        except Exception:
            # If even checking the page's status fails, assume it's dead.
            self.controller.page = None

    def execute(self, action: ExecutionAction | dict[str, Any]) -> ExecutionResult:
        action = ExecutionAction.from_dict(action) if isinstance(action, dict) else action
        if action.platform != "browser":
            return ExecutionResult(False, "browser", action.action, "Action targets a different platform.")
        try:
            self.approval_gate.ensure_allowed(action)
            if action.action == "load_session":
                return self._load_session(action)
            self._ensure_page_alive()
            self.start(**action.parameters.get("browser_options", {}))
            page = self.controller.page
            before = {"url": page.url, "title": page.title()}
            data = self._perform(page, action)
            evidence = self._verify(page, action, before, data)
            return ExecutionResult(True, "browser", action.action, "Completed", data=data, evidence=evidence)
        except Exception as error:
            evidence = {"recovery": self.recovery.recover(self.controller.page).__dict__} if self.controller.page else {}
            return ExecutionResult(False, "browser", action.action, "Browser action failed", evidence=evidence, error=str(error))

    def _locator(self, page, target: dict[str, Any]):
        if "selector" in target:
            return page.locator(target["selector"]).first
        if "role" in target:
            return page.get_by_role(target["role"], name=target.get("name")).first
        if "label" in target:
            return page.get_by_label(target["label"], exact=target.get("exact", False)).first
        if "placeholder" in target:
            return page.get_by_placeholder(target["placeholder"], exact=target.get("exact", False)).first
        if "text" in target:
            return page.get_by_text(target["text"], exact=target.get("exact", False)).first
        raise ValueError("Browser action needs selector, role, label, placeholder, or text target.")

    def _perform(self, page, action: ExecutionAction):
        name, target, value = action.action, action.target, action.value
        if name == "navigate":
            response = page.goto(str(value or action.parameters["url"]), wait_until="domcontentloaded")
            return response.url if response else page.url
        if name == "save_session":
            path = action.parameters.get("path") or self.sessions.path_for(str(value or action.parameters["name"]))
            self.controller.engine.context.storage_state(path=path)
            return path
        if name == "login":
            return self._login(page, action)
        if name == "fill_form":
            return self._fill_form(page, action)
        if name == "inspect_page":
            return self.observer.inspect(
                page,
                max_text_length=action.parameters.get("max_text_length", 6000),
                max_elements=action.parameters.get("max_elements", 200),
            ).as_dict()
        if name == "new_tab":
            new_page = self.controller.new_tab()
            url = value or action.parameters.get("url")
            if url:
                new_page.goto(str(url), wait_until="domcontentloaded")
            return len(self.controller.tabs()) - 1
        if name == "switch_tab":
            index = int(value if value is not None else action.parameters["index"])
            if not self.controller.switch_tab(index):
                raise IndexError(f"No browser tab at index {index}.")
            return index
        if name == "close_tab":
            index = value if value is not None else action.parameters.get("index")
            return self.controller.close_tab(None if index is None else int(index))
        if name == "read_text":
            locator = self._locator(page, target)
            locator.wait_for(state="visible", timeout=action.parameters.get("timeout", 10000))
            return locator.inner_text()
        if name == "read_tables":
            return TableReaderSkill(page).read()
        if name == "next_page":
            return PaginationSkill(page).next_page()
        if name == "previous_page":
            return PaginationSkill(page).previous_page()
        if name == "infinite_scroll":
            return InfiniteScrollSkill(page).scroll(
                max_scrolls=int(action.parameters.get("max_scrolls", 10)),
                pause=float(action.parameters.get("pause", 1.0)),
            )
        if name == "inspect_page_state":
            verifier = BrowserVerifier(page)
            return {
                "loading": verifier.loading(), "dialog_open": verifier.dialog_open(),
                "has_error": verifier.has_error(), "url": page.url, "title": page.title(),
            }
        if name == "dismiss_safe_popup":
            report = self.recovery.recover(page)
            return {"recovered": report.recovered, "steps": report.steps}
        if name == "wait_for":
            return self._wait_for(page, action)
        if name == "back":
            return page.go_back()
        if name == "forward":
            return page.go_forward()
        if name == "refresh":
            return page.reload().url
        locator = self._locator(page, target)
        locator.wait_for(state="visible", timeout=action.parameters.get("timeout", 10000))
        if name == "click":
            locator.click(); return True
        if name == "hover":
            locator.hover(); return True
        if name == "fill":
            locator.fill(str(value)); return True
        if name == "type":
            locator.press_sequentially(str(value), delay=action.parameters.get("delay", 20)); return True
        if name == "press":
            locator.press(str(value or action.parameters.get("key", "Enter"))); return True
        if name == "select":
            locator.select_option(value); return True
        if name == "check":
            locator.check(); return True
        if name == "uncheck":
            locator.uncheck(); return True
        if name == "upload":
            file = Path(str(value)).resolve()
            if not file.is_file():
                raise FileNotFoundError(file)
            locator.set_input_files(str(file))
            # Browser security prevents reading the local path back; file count is
            # the reliable verification that the input accepted the upload.
            if locator.evaluate("element => element.files ? element.files.length : 0") < 1:
                raise RuntimeError("Browser did not accept the selected upload file.")
            return str(file)
        if name == "download":
            directory = Path(action.parameters.get("directory", "browser/downloads"))
            directory.mkdir(parents=True, exist_ok=True)
            with page.expect_download() as info:
                locator.click()
            download = info.value
            output = directory / download.suggested_filename
            download.save_as(str(output))
            if not output.is_file() or output.stat().st_size == 0:
                raise RuntimeError("Download was not saved correctly.")
            return str(output)
        raise ValueError(f"Unsupported browser action: {name}")

    def _load_session(self, action: ExecutionAction) -> ExecutionResult:
        """Start a clean browser context from a previously saved local session state."""
        name_or_path = str(action.value or action.parameters.get("path") or action.parameters.get("name", ""))
        path = Path(name_or_path)
        if not path.is_file():
            path = Path(self.sessions.path_for(name_or_path))
        if not path.is_file():
            return ExecutionResult(False, "browser", action.action, "Saved browser session was not found.", data=str(path))
        self.stop()
        options = dict(action.parameters.get("browser_options", {}))
        options["storage_state_path"] = str(path)
        self.start(**options)
        return ExecutionResult(True, "browser", action.action, "Session loaded", data=str(path),
                               evidence={"verified": self.controller.page is not None})

    def _login(self, page, action: ExecutionAction) -> bool:
        """Credentials arrive only in the current approved action and are never persisted/logged here."""
        credentials = action.value or {}
        if not isinstance(credentials, dict) or not credentials.get("username") or not credentials.get("password"):
            raise ValueError("Login requires username and password values.")
        targets = action.parameters.get("targets", {})
        self._locator(page, targets["username"]).fill(str(credentials["username"]))
        self._locator(page, targets["password"]).fill(str(credentials["password"]))
        self._locator(page, targets["submit"]).click()
        page.wait_for_load_state("domcontentloaded")
        return True

    def _fill_form(self, page, action: ExecutionAction) -> int:
        """Fill named form fields without submitting; submit must be a separately approved action."""
        fields = action.value or []
        if not isinstance(fields, list):
            raise ValueError("fill_form requires a list of {target, value} fields.")
        for field in fields:
            self._locator(page, field["target"]).fill(str(field["value"]))
        return len(fields)

    def _wait_for(self, page, action: ExecutionAction) -> bool:
        timeout = action.parameters.get("timeout", 10000)
        if "url" in action.parameters:
            page.wait_for_url(action.parameters["url"], timeout=timeout)
            return True
        locator = self._locator(page, action.target)
        locator.wait_for(state=action.parameters.get("state", "visible"), timeout=timeout)
        return True

    def _verify(self, page, action: ExecutionAction, before: dict[str, str], data: Any) -> dict[str, Any]:
        evidence = {"url": page.url, "title": page.title()}
        if action.action == "fill":
            evidence["verified"] = self._locator(page, action.target).input_value() == str(action.value)
        elif action.action == "read_text":
            evidence["verified"] = isinstance(data, str)
        elif action.action == "read_tables":
            evidence["verified"] = isinstance(data, list)
        elif action.action == "save_session":
            evidence["verified"] = Path(str(data)).is_file()
        elif action.action == "fill_form":
            evidence["verified"] = data > 0
        elif action.action == "inspect_page":
            evidence["verified"] = isinstance(data, dict) and "elements" in data
        elif action.action == "download":
            evidence["verified"] = Path(str(data)).is_file()
        elif action.action == "upload":
            evidence["verified"] = bool(data)
        elif action.action in {"check", "uncheck"}:
            evidence["verified"] = self._locator(page, action.target).is_checked() == (action.action == "check")
        elif action.action == "inspect_page_state":
            evidence["verified"] = isinstance(data, dict) and {"loading", "dialog_open", "has_error"}.issubset(data)
        else:
            evidence["verified"] = True
        expected_url = action.parameters.get("expected_url_contains")
        if expected_url:
            evidence["expected_url_matches"] = expected_url in page.url
            evidence["verified"] = evidence["verified"] and evidence["expected_url_matches"]
        expected_text = action.parameters.get("expected_text")
        if expected_text:
            evidence["expected_text_matches"] = expected_text in page.locator("body").inner_text()
            evidence["verified"] = evidence["verified"] and evidence["expected_text_matches"]
        evidence["page_changed"] = before["url"] != page.url or before["title"] != evidence["title"]
        if action.parameters.get("expect_page_change"):
            evidence["verified"] = evidence["verified"] and evidence["page_changed"]
        return evidence