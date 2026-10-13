class SessionManager:

    def __init__(self):

        self.reset()

    def reset(self):

        self.active_app = None

        self.active_window = None

        self.current_task = None

        self.current_workflow = []

    def set_active_app(self, app):

        self.active_app = app

    def get_active_app(self):

        return self.active_app

    def set_active_window(self, title):

        self.active_window = title

    def get_active_window(self):

        return self.active_window

    def set_task(self, task):

        self.current_task = task

    def get_task(self):

        return self.current_task

    def add_action(self, action):

        self.current_workflow.append(action)

    def history(self):

        return list(self.current_workflow)

    def clear_history(self):

        self.current_workflow.clear()