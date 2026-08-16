"""Tests for NexusController's command -> ExecutionAction -> execution bridge.

These mock the LLM call and execute_action, so they never touch a real
microphone, LLM API, or app -- they verify the wiring/logic only.
"""
import json
from types import SimpleNamespace

from controller import NexusController
from common import ExecutionResult


def _fake_llm_response(text):
    message = SimpleNamespace(content=text)
    choice = SimpleNamespace(message=message)
    return SimpleNamespace(choices=[choice])


def test_chat_intent_calls_llm_ask(monkeypatch):
    controller = NexusController()
    monkeypatch.setattr(controller.llm, "ask", lambda command: "hello back")
    assert controller.handle("hello there") == "hello back"


def test_task_intent_plans_and_executes_low_risk_action(monkeypatch):
    controller = NexusController()
    plan = json.dumps({"actions": [{"platform": "desktop", "action": "open_app", "value": "notepad"}]})
    monkeypatch.setattr(
        controller.llm.client.chat.completions, "create",
        lambda **kwargs: _fake_llm_response(plan),
    )
    monkeypatch.setattr(
        controller, "execute_action",
        lambda action: ExecutionResult(True, "desktop", "open_app", "Completed"),
    )
    response = controller.handle("notepad khol do")
    assert "open_app" in response
    assert "ho gaya" in response


def test_high_risk_action_asks_for_confirmation_before_retrying(monkeypatch):
    calls = []

    def fake_execute(action):
        calls.append(dict(action))
        if "approval_token" not in action:
            return ExecutionResult(False, "desktop", "delete_file", "Action blocked pending user approval.")
        return ExecutionResult(True, "desktop", "delete_file", "Completed")

    confirmations = []

    def confirm(prompt):
        confirmations.append(prompt)
        return True

    controller = NexusController(confirm_callback=confirm)
    plan = json.dumps({"actions": [{"platform": "desktop", "action": "delete_file", "value": "old.txt"}]})
    monkeypatch.setattr(
        controller.llm.client.chat.completions, "create",
        lambda **kwargs: _fake_llm_response(plan),
    )
    monkeypatch.setattr(controller, "execute_action", fake_execute)

    response = controller.handle("purani file delete kardo")

    assert len(calls) == 2
    assert calls[1]["approval_token"] == "user_voice_confirmed"
    assert len(confirmations) == 1
    assert "ho gaya" in response


def test_declined_confirmation_does_not_retry(monkeypatch):
    calls = []

    def fake_execute(action):
        calls.append(dict(action))
        return ExecutionResult(False, "desktop", "delete_file", "Action blocked pending user approval.")

    controller = NexusController(confirm_callback=lambda prompt: False)
    plan = json.dumps({"actions": [{"platform": "desktop", "action": "delete_file", "value": "old.txt"}]})
    monkeypatch.setattr(
        controller.llm.client.chat.completions, "create",
        lambda **kwargs: _fake_llm_response(plan),
    )
    monkeypatch.setattr(controller, "execute_action", fake_execute)

    response = controller.handle("purani file delete kardo")

    assert len(calls) == 1
    assert "approval nahi mila" in response


def test_unsupported_action_falls_back_to_chat(monkeypatch):
    controller = NexusController()
    plan = json.dumps({"actions": [{"platform": "desktop", "action": "launch_missiles", "value": None}]})
    monkeypatch.setattr(
        controller.llm.client.chat.completions, "create",
        lambda **kwargs: _fake_llm_response(plan),
    )
    monkeypatch.setattr(controller.llm, "ask", lambda command: "fallback chat answer")
    response = controller.handle("notepad ke sath kuch karo")
    assert response == "fallback chat answer"


def test_no_actions_planned_falls_back_to_chat(monkeypatch):
    controller = NexusController()
    plan = json.dumps({"actions": []})
    monkeypatch.setattr(
        controller.llm.client.chat.completions, "create",
        lambda **kwargs: _fake_llm_response(plan),
    )
    monkeypatch.setattr(controller.llm, "ask", lambda command: "fallback chat answer")
    response = controller.handle("notepad ke baare mein kya khayal hai")
    assert response == "fallback chat answer"
