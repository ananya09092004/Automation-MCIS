"""P2.12 -- windows_registry.py must not crash non-Windows environments.

Previously `import winreg` ran unconditionally at module import time --
simply importing this module (or anything that imports it, like
desktop.application_manager.registry) raised ModuleNotFoundError on
macOS/Linux, before registry.py's own `platform.system() == "Windows"`
guard ever got a chance to run. This is exactly why test_authorization_
boundary.py and others couldn't even be collected in this environment
before the fix (see the CI workflow's comment on why a curated test
list is used instead of the whole tests/ directory).

These tests run on whatever platform CI/this sandbox actually is
(Linux) -- the point is that importing and using this module must not
crash there, not that it exercises real Windows registry behavior
(that needs a real Windows machine, and is handled by RegistryDiscovery
already choosing not to call into WindowsRegistry off-Windows).
"""

from desktop.application_manager.windows_registry import WindowsRegistry
from desktop.application_manager.registry import RegistryDiscovery


def test_importing_the_module_does_not_crash_on_a_non_windows_platform():
    # If this test file could even be collected, the import already
    # succeeded -- this assertion just documents the intent.
    assert WindowsRegistry is not None


def test_windows_registry_find_degrades_to_no_match_instead_of_crashing():
    result = WindowsRegistry().find("notepad")
    assert result is None


def test_windows_registry_find_handles_empty_query_without_crashing():
    assert WindowsRegistry().find("") is None
    assert WindowsRegistry().find("   ") is None


def test_registry_discovery_still_falls_back_to_path_lookup():
    # python3 (or python) is near-guaranteed to be on PATH in any
    # environment capable of running this test suite at all.
    import shutil
    expected = shutil.which("python3") or shutil.which("python")
    if expected is None:
        return  # nothing on PATH to find in this exotic environment -- not this fix's concern
    found = RegistryDiscovery().find("python3") or RegistryDiscovery().find("python")
    assert found is not None
