"""Tests for NexusController's universal 'change this file however I
describe' flow (ai_edit_document): resolve the path (searching if just a
name was given), read the file, ask the LLM to propose new content + a
summary, confirm by voice, then write it back. All mocked -- no real
file, LLM, or mic touched.
"""
import json
from types import SimpleNamespace

from controller import NexusController
from common import ExecutionResult


def _fake_llm_response(text):
    message = SimpleNamespace(content=text)
    choice = SimpleNamespace(message=message)
    return SimpleNamespace(choices=[choice])


def _planner_then_proposal_responses(plan_json, proposal_json):
    """The controller calls the LLM twice for this flow: once to plan the
    action, once to propose the edit. Return each in turn."""
    responses = [_fake_llm_response(plan_json), _fake_llm_response(proposal_json)]

    def create(**kwargs):
        return responses.pop(0)

    return create


def _plan_for(path, instruction):
    return json.dumps({
        "actions": [{
            "platform": "desktop", "action": "ai_edit_document",
            "parameters": {"path": path}, "value": instruction,
        }]
    })


def test_full_edit_flow_resolves_reads_proposes_confirms_and_writes(monkeypatch):
    plan = _plan_for("resume.docx", "make the experience section punchier")
    proposal = json.dumps({
        "summary": "Tightened the experience section wording.",
        "new_content": "Experience\nShipped a full execution engine end to end.",
    })

    controller = NexusController(confirm_callback=lambda prompt: True)
    monkeypatch.setattr(
        controller.llm.client.chat.completions, "create",
        _planner_then_proposal_responses(plan, proposal),
    )

    calls = []

    def fake_execute(action):
        calls.append(dict(action))
        if action["action"] == "find_document":
            return ExecutionResult(True, "desktop", "find_document", "Completed", data=["C:/Users/anush/Documents/resume.docx"])
        if action["action"] == "read_document":
            return ExecutionResult(True, "desktop", "read_document", "Completed", data="Experience\nOld wording.")
        if action["action"] == "write_document":
            return ExecutionResult(True, "desktop", "write_document", "Completed")
        raise AssertionError(f"unexpected action {action}")

    monkeypatch.setattr(controller, "execute_action", fake_execute)
    monkeypatch.setattr("os.path.isfile", lambda path: False)

    response = controller.handle("resume.docx mein experience section punchier bana do")

    assert calls[0]["action"] == "find_document"
    assert calls[1]["action"] == "read_document"
    assert calls[1]["parameters"]["path"] == "C:/Users/anush/Documents/resume.docx"
    assert calls[2]["action"] == "write_document"
    assert "Tightened the experience section wording." in response


def test_direct_existing_path_skips_search(monkeypatch):
    plan = _plan_for("C:/exact/path/resume.docx", "polish it")
    proposal = json.dumps({"summary": "Polished it.", "new_content": "New text"})

    controller = NexusController(confirm_callback=lambda prompt: True)
    monkeypatch.setattr(
        controller.llm.client.chat.completions, "create",
        _planner_then_proposal_responses(plan, proposal),
    )

    calls = []

    def fake_execute(action):
        calls.append(dict(action))
        if action["action"] == "read_document":
            return ExecutionResult(True, "desktop", "read_document", "Completed", data="Old text")
        if action["action"] == "write_document":
            return ExecutionResult(True, "desktop", "write_document", "Completed")
        raise AssertionError(f"unexpected action {action}, search should have been skipped")

    monkeypatch.setattr(controller, "execute_action", fake_execute)
    monkeypatch.setattr("os.path.isfile", lambda path: path == "C:/exact/path/resume.docx")

    controller.handle("C:/exact/path/resume.docx polish it")

    assert all(call["action"] != "find_document" for call in calls)


def test_ambiguous_matches_asks_for_clarification(monkeypatch):
    plan = _plan_for("resume.docx", "polish it")
    controller = NexusController(confirm_callback=lambda prompt: True)
    monkeypatch.setattr(
        controller.llm.client.chat.completions, "create",
        lambda **kwargs: _fake_llm_response(plan),
    )

    def fake_execute(action):
        assert action["action"] == "find_document"
        return ExecutionResult(True, "desktop", "find_document", "Completed",
                                data=["C:/a/resume.docx", "C:/b/resume.docx"])

    monkeypatch.setattr(controller, "execute_action", fake_execute)
    monkeypatch.setattr("os.path.isfile", lambda path: False)

    response = controller.handle("resume.docx mein changes karo")

    assert "2 files mili" in response
    assert "Poora path bata" in response


def test_no_matches_reports_not_found(monkeypatch):
    plan = _plan_for("does-not-exist.docx", "polish it")
    controller = NexusController(confirm_callback=lambda prompt: True)
    monkeypatch.setattr(
        controller.llm.client.chat.completions, "create",
        lambda **kwargs: _fake_llm_response(plan),
    )

    def fake_execute(action):
        assert action["action"] == "find_document"
        return ExecutionResult(True, "desktop", "find_document", "Completed", data=[])

    monkeypatch.setattr(controller, "execute_action", fake_execute)
    monkeypatch.setattr("os.path.isfile", lambda path: False)

    response = controller.handle("does-not-exist.docx mein changes karo")

    assert "nahi mili" in response


def test_declined_confirmation_does_not_write(monkeypatch):
    plan = _plan_for("resume.docx", "make it better")
    proposal = json.dumps({"summary": "Made it punchier.", "new_content": "New text"})

    controller = NexusController(confirm_callback=lambda prompt: False)
    monkeypatch.setattr(
        controller.llm.client.chat.completions, "create",
        _planner_then_proposal_responses(plan, proposal),
    )

    calls = []

    def fake_execute(action):
        calls.append(dict(action))
        if action["action"] == "find_document":
            return ExecutionResult(True, "desktop", "find_document", "Completed", data=["C:/x/resume.docx"])
        return ExecutionResult(True, "desktop", "read_document", "Completed", data="Old text")

    monkeypatch.setattr(controller, "execute_action", fake_execute)
    monkeypatch.setattr("os.path.isfile", lambda path: False)

    response = controller.handle("resume.docx mein changes karo")

    assert all(call["action"] != "write_document" for call in calls)
    assert "save nahi kiye" in response


def test_missing_path_asks_for_clarification(monkeypatch):
    plan = json.dumps({"actions": [{"platform": "desktop", "action": "open_app", "value": "notepad"}]})
    controller = NexusController()
    monkeypatch.setattr(
        controller.llm.client.chat.completions, "create",
        lambda **kwargs: _fake_llm_response(plan),
    )
    monkeypatch.setattr(
        controller, "execute_action",
        lambda action: ExecutionResult(True, "desktop", "open_app", "Completed"),
    )
    response = controller.handle("notepad khol do")
    assert "ho gaya" in response
