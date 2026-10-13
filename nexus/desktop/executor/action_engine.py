from desktop.executor.ui_executor import UIExecutor
from desktop.executor.scroll_executor import ScrollExecutor
from desktop.executor.input_executor import InputExecutor
from desktop.app_controller.controller import AppController
from desktop.file_manager.controller import FileManager
from desktop.folder_manager.controller import FolderManager
from desktop.terminal.controller import TerminalController


class ActionEngine:

    def __init__(self):

        self.ui = UIExecutor()

        self.scroll = ScrollExecutor()

        self.input = InputExecutor()

        self.apps = AppController()

        self.files = FileManager()

        self.folders = FolderManager()

        self.terminal = TerminalController()

    def execute(self, action: dict):

        action_type = action["action"]

        if action_type == "open_app":
            return self.apps.open_app(action["name"])

        elif action_type == "click":
            return self.ui.click(action["text"])

        elif action_type == "double_click":
            return self.ui.double_click(action["text"])

        elif action_type == "right_click":
            return self.ui.right_click(action["text"])

        elif action_type == "type":
            return self.input.type(action["text"])

        elif action_type == "press_enter":
            return self.input.enter()

        elif action_type == "scroll_down":
            return self.scroll.scroll_down()

        elif action_type == "scroll_up":
            return self.scroll.scroll_up()

        elif action_type == "scroll_to":
            return self.scroll.scroll_to_text(
                action["text"]
            )

        elif action_type == "create_file":
            return self.files.create_file(
                action["path"]
            )

        elif action_type == "create_folder":
            return self.folders.create_folder(
                action["path"]
            )

        elif action_type == "terminal":
            return self.terminal.run(
                action["command"]
            )

        return False