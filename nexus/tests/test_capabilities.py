from common import default_capabilities


def test_registry_exposes_generic_desktop_and_browser_actions():
    capabilities = default_capabilities()
    assert capabilities.supports("desktop", "click_target")
    assert capabilities.supports("browser", "inspect_page")
    assert not capabilities.supports("browser", "pay")
