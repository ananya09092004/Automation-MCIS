class ContextManager:

    def __init__(self):

        self.clear()

    def clear(self):

        self._context = {}

    def set(self, key, value):

        self._context[key] = value

    def get(self, key, default=None):

        return self._context.get(

            key,

            default

        )

    def update(self, **kwargs):

        self._context.update(kwargs)

    def remove(self, key):

        if key in self._context:

            del self._context[key]

    def exists(self, key):

        return key in self._context

    def all(self):

        return dict(self._context)