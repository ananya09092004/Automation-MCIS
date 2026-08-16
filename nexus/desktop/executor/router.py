from desktop.app_controller.controller import AppController
from desktop.file_manager import FileManager
from desktop.folder_manager import FolderManager
from desktop.terminal import TerminalController
from desktop.clipboard.controller import ClipboardController
from desktop.mouse.controller import MouseController
from desktop.keyboard.controller import KeyboardController
from desktop.window_manager.manager import WindowManager
from desktop.process_manager.controller import ProcessManager
from desktop.notification.controller import NotificationController
from desktop.screenshot.controller import ScreenshotController


class ActionRouter:

    def __init__(self):

        self.apps = AppController()

        self.files = FileManager()

        self.folders = FolderManager()

        self.terminal = TerminalController()

        self.clipboard = ClipboardController()

        self.mouse = MouseController()

        self.keyboard = KeyboardController()

        self.windows = WindowManager()

        self.process = ProcessManager()

        self.notification = NotificationController()

        self.screenshot = ScreenshotController()

    def execute(self, action):

        if hasattr(action, "__dict__"):
            action = vars(action)

        name = action["action"]

        # -------------------------
        # Applications
        # -------------------------

        if name == "open_app":

            return self.apps.open_app(
                action["app"]
            )

        elif name == "close_app":
            return self.apps.close_app(action["app"])

        elif name == "restart_app":
            return self.apps.restart_app(action["app"])

        elif name == "focus_app":
            return self.apps.focus_app(action["app"])

        elif name == "minimize_app":
            return self.apps.minimize_app(action["app"])

        elif name == "maximize_app":
            return self.apps.maximize_app(action["app"])

        elif name == "switch_to_app":
            return self.apps.switch_to_app(action["app"])

        elif name == "get_running_apps":
            return self.apps.get_running_apps()

        # -------------------------
        # Files
        # -------------------------

        elif name == "create_file":

            return self.files.create_file(
                action["path"]
            )

        elif name == "delete_file":

            return self.files.delete_file(
                action["path"]
            )

        elif name == "copy_file":

            return self.files.copy_file(
                action["source"],
                action["destination"]
            )

        elif name == "move_file":

            return self.files.move_file(
                action["source"],
                action["destination"]
            )

        elif name == "rename_file":

            return self.files.rename_file(
                action["source"],
                action["new_name"]
            )

        elif name == "read_file":
            return self.files.read_file(action["path"])

        elif name == "write_file":
            return self.files.write_file(action["path"], action.get("content", action.get("text", "")))

        elif name == "search_file":
            return self.files.search_file(action["directory"], action["query"])

        elif name == "verify_path":
            return self.files.exists(action["path"])

        # -------------------------
        # Folders
        # -------------------------

        elif name == "create_folder":

            return self.folders.create_folder(
                action["path"]
            )

        elif name == "delete_folder":

            return self.folders.delete_folder(
                action["path"]
            )

        elif name == "move_folder":

            return self.folders.move_folder(
                action["source"],
                action["destination"]
            )

        elif name == "copy_folder":
            return self.folders.copy_folder(action["source"], action["destination"])

        elif name == "search_folder":
            return self.folders.search_folder(action["directory"], action["query"])

        elif name == "list_folder":
            return self.folders.list_folder(action["path"])

        elif name == "rename_folder":

            return self.folders.rename_folder(
                action["source"],
                action["new_name"]
            )

        # -------------------------
        # Clipboard
        # -------------------------

        elif name == "copy_text":

            return self.clipboard.copy(
                action["text"]
            )

        elif name == "paste_text":

            return self.clipboard.paste()

        elif name == "get_clipboard":

            return self.clipboard.get()

        elif name == "clear_clipboard":

            return self.clipboard.clear()

        elif name == "cut_clipboard":
            return self.clipboard.cut()

        # -------------------------
        # Mouse
        # -------------------------

        elif name == "move_mouse":

            return self.mouse.move(
                action["x"],
                action["y"]
            )

        elif name == "click":

            return self.mouse.click()

        elif name == "double_click":

            return self.mouse.double_click()

        elif name == "right_click":

            return self.mouse.right_click()

        elif name == "scroll_up":

            return self.mouse.scroll_up(
                action.get("amount", 500)
            )

        elif name == "scroll_down":

            return self.mouse.scroll_down(
                action.get("amount", 500)
            )

        elif name == "drag_mouse":

            return self.mouse.drag_to(
                action["x"],
                action["y"]
            )

        elif name == "mouse_position":

            return self.mouse.position()

        # -------------------------
        # Keyboard
        # -------------------------

        elif name == "type_text":

            return self.keyboard.type_text(
                action["text"]
            )

        elif name == "press_key":

            return self.keyboard.press(
                action["key"]
            )

        elif name == "hotkey":

            return self.keyboard.hotkey(
                *action["keys"]
            )

        elif name == "select_all":
            return self.keyboard.select_all()

        elif name == "copy_selection":
            return self.keyboard.copy()

        elif name == "paste_selection":
            return self.keyboard.paste()

        elif name == "cut_selection":
            return self.keyboard.cut()

        # -------------------------
        # Windows
        # -------------------------

        elif name == "focus_window":

            return self.windows.focus(
                action["title"]
            )

        elif name == "maximize_window":

            return self.windows.maximize(
                action["title"]
            )

        elif name == "minimize_window":

            return self.windows.minimize(
                action["title"]
            )

        elif name == "close_window":

            return self.windows.close(
                action["title"]
            )

        elif name == "window_exists":

            return self.windows.exists(
                action["title"]
            )

        elif name == "active_window":
            return self.windows.active_window()

        # -------------------------
        # Process
        # -------------------------

        elif name == "start_process":

            return self.process.start(
                action["command"]
            )

        elif name == "kill_process":

            return self.process.kill(action.get("pid", action.get("process_name")))

        elif name == "restart_process":
            return self.process.restart(action["process_name"], action.get("command"))

        elif name == "list_processes":
            return self.process.list_processes()

        # -------------------------
        # Notification
        # -------------------------

        elif name == "notify":

            return self.notification.show(
                action["title"],
                action["message"]
            )

        elif name == "read_notifications":
            return self.notification.read_history(action.get("limit", 50))

        elif name == "clear_notifications":
            return self.notification.clear_history()

        # -------------------------
        # Screenshots
        # -------------------------

        elif name == "capture_screen":
            return self.screenshot.save(action["path"])

        elif name == "capture_active_window":
            return self.screenshot.capture_active_window(action["path"])

        # -------------------------
        # Terminal
        # -------------------------

        elif name == "run_terminal":

            return self.terminal.run(
                action["command"],
                action.get("cwd")
            )

        raise Exception(
            f"Unknown action : {name}"
        )
