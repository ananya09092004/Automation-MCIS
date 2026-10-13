from browser.recovery import BrowserRecovery


class FakeButton:
    def __init__(self): self.clicked = False
    def count(self): return 1
    @property
    def first(self): return self
    def is_visible(self): return True
    def click(self): self.clicked = True


class FakePage:
    def __init__(self): self.button = FakeButton()
    def is_closed(self): return False
    def wait_for_load_state(self, *_args, **_kwargs): return None
    def get_by_role(self, _role, name, exact):
        if name == "Close": return self.button
        return type("Empty", (), {"count": lambda self: 0})()


def test_recovery_waits_and_only_closes_safe_dialogs():
    page = FakePage()
    report = BrowserRecovery().recover(page)
    assert report.recovered
    assert page.button.clicked
    assert report.steps == ["waited_for_dom", "dismissed_close"]
