from desktop.clipboard.controller import ClipboardController
from desktop.terminal.controller import TerminalController


def test_terminal_returns_structured_output_for_a_safe_command():
    result = TerminalController().run("powershell -NoProfile -Command \"Write-Output Nexus\"")
    assert result.success
    assert "Nexus" in result.stdout


def test_clipboard_controller_exposes_copy_paste_clear_contract(monkeypatch):
    stored = {"value": ""}
    monkeypatch.setattr("pyperclip.copy", lambda value: stored.__setitem__("value", value))
    monkeypatch.setattr("pyperclip.paste", lambda: stored["value"])
    clipboard = ClipboardController()
    assert clipboard.copy("Nexus")
    assert clipboard.get() == "Nexus"
    assert clipboard.clear()
    assert clipboard.paste() == ""
