"""Discoverable execution capabilities exposed to the Brain/orchestrator."""

from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class Capability:
    platform: str
    action: str
    description: str
    risk: str = "low"


class CapabilityRegistry:
    def __init__(self):
        self._items: dict[tuple[str, str], Capability] = {}

    def register(self, capability: Capability) -> None:
        self._items[(capability.platform, capability.action)] = capability

    def supports(self, platform: str, action: str) -> bool:
        return (platform, action) in self._items

    def list(self, platform: str | None = None) -> list[dict]:
        values = self._items.values()
        if platform:
            values = (item for item in values if item.platform == platform)
        return [asdict(item) for item in sorted(values, key=lambda item: (item.platform, item.action))]


def default_capabilities() -> CapabilityRegistry:
    registry = CapabilityRegistry()
    desktop = {
        "open_app": "Launch an installed desktop app", "close_app": "Close an app", "restart_app": "Restart an app",
        "focus_app": "Focus an app", "minimize_app": "Minimize an app", "maximize_app": "Maximize an app",
        "switch_to_app": "Switch to an app", "get_running_apps": "List running app processes",
        "create_file": "Create a file", "read_file": "Read a text file", "write_file": "Write a text file",
        "rename_file": "Rename a file", "copy_file": "Copy a file", "move_file": "Move a file", "delete_file": "Delete a file", "verify_path": "Verify that a file or folder path exists",
        "search_file": "Search files", "create_folder": "Create folder", "rename_folder": "Rename folder",
        "copy_folder": "Copy a folder", "move_folder": "Move a folder", "delete_folder": "Delete a folder", "search_folder": "Search folders", "list_folder": "List direct folder contents",
        "copy_text": "Copy text to clipboard", "paste_text": "Read clipboard text", "get_clipboard": "Read clipboard", "clear_clipboard": "Clear clipboard", "cut_clipboard": "Cut clipboard text",
        "move_mouse": "Move mouse pointer", "click": "Left-click mouse", "double_click": "Double-click mouse", "right_click": "Right-click mouse", "drag_mouse": "Drag mouse", "scroll_up": "Scroll up", "scroll_down": "Scroll down", "mouse_position": "Read mouse position",
        "type_text": "Type text through keyboard", "press_key": "Press a keyboard key", "hotkey": "Press a keyboard shortcut", "select_all": "Select all", "copy_selection": "Copy selected text", "paste_selection": "Paste selected text", "cut_selection": "Cut selected text",
        "focus_window": "Focus a window", "minimize_window": "Minimize a window", "maximize_window": "Maximize a window", "close_window": "Close a window", "window_exists": "Check for a window", "active_window": "Read active window",
        "start_process": "Start a process", "kill_process": "Stop a process", "restart_process": "Restart a process", "list_processes": "List processes",
        "notify": "Show a desktop notification", "read_notifications": "Read Nexus notification history", "clear_notifications": "Clear Nexus notification history", "capture_screen": "Capture a screenshot", "capture_active_window": "Capture the active window",
        "click_target": "Click an accessible desktop control", "fill_target": "Fill an accessible desktop control",
        "read_target": "Read an accessible desktop control", "target_exists": "Check a desktop target",
        "wait_for_target": "Wait for a desktop target", "inspect_window": "Inspect visible app controls", "inspect_screen_state": "Detect visible error, loading, or success state",
        "capture_screen": "Capture the current screen", "run_terminal": "Run a terminal command",
        "open_path": "Open a folder in File Explorer", "reveal_file": "Reveal a file in File Explorer",
        "open_file": "Open a file with its default app", "list_items": "List folder contents", "search_items": "Search File Explorer items",
        "create_word_document": "Create a Word document", "create_excel_workbook": "Create an Excel workbook",
        "create_powerpoint_presentation": "Create a PowerPoint presentation", "read_word_document": "Read a Word document", "read_excel_rows": "Read Excel rows", "inspect_powerpoint_presentation": "Inspect PowerPoint slide count", "open_office_document": "Open an Office document",
    }
    browser = {
        "navigate": "Open a URL", "new_tab": "Open a browser tab", "switch_tab": "Switch browser tab",
        "close_tab": "Close browser tab", "inspect_page": "Read visible page structure", "read_text": "Read page text",
        "wait_for": "Wait for URL or element", "back": "Go back", "forward": "Go forward", "refresh": "Refresh page",
        "click": "Click a page control", "hover": "Hover a page control", "fill": "Fill a field",
        "type": "Type into a field", "press": "Press a key", "select": "Select option", "check": "Check option", "uncheck": "Uncheck option",
        "upload": "Upload and verify a file", "download": "Download and verify a file", "save_session": "Save browser session state", "load_session": "Reuse a saved browser session",
        "login": "Log in through an approved browser action", "fill_form": "Fill a form without submitting",
        "read_tables": "Read HTML tables", "next_page": "Move to next pagination page", "previous_page": "Move to previous pagination page",
        "infinite_scroll": "Scroll until page content stops growing", "inspect_page_state": "Inspect loading, dialog, and error state",
        "dismiss_safe_popup": "Dismiss only Close, Cancel, or Dismiss popups",
    }
    risky = {"close_app", "close_window", "write_file", "rename_file", "move_file", "delete_file", "rename_folder", "move_folder", "delete_folder", "kill_process", "run_terminal"}
    for action, description in desktop.items():
        registry.register(Capability("desktop", action, description, "high" if action in risky else "low"))
    for action, description in browser.items():
        registry.register(Capability("browser", action, description, "low"))
    return registry
