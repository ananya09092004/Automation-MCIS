from pathlib import Path

from common.capabilities import default_capabilities


def test_every_registered_action_is_listed_in_supported_actions_document():
    document = (Path(__file__).parents[1] / "docs" / "09_supported_actions.md").read_text(encoding="utf-8")
    missing = [item["action"] for item in default_capabilities().list() if f"`{item['action']}`" not in document]
    assert not missing, f"Undocumented supported actions: {missing}"
