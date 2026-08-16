"""Run Nexus acceptance checks in explicit safe stages.

Default mode runs only non-live tests.  --live uses local temporary files/apps;
--office is separate because Microsoft Office COM is machine-specific.
"""

import argparse
import subprocess
import sys


UNIT_TESTS = [
    "tests/test_execution_contracts.py",
    "tests/test_file_folder_managers_unit.py",
    "tests/test_file_folder_verification_unit.py",
    "tests/test_execution_workflow.py",
    "tests/test_capabilities.py",
    "tests/test_desktop_controls_unit.py",
    "tests/test_capability_documentation_unit.py",
    "tests/test_notifications_unit.py",
    "tests/test_screen_state_detector_unit.py",
    "tests/test_template_matcher.py",
    "tests/test_accessibility_fallback_unit.py",
    "tests/test_desktop_workflow_unit.py",
    "tests/test_execution_evidence_unit.py",
    "tests/test_workflow_recovery_report_unit.py",
    "tests/test_safety_acceptance_unit.py",
]

LOCAL_BROWSER_TESTS = [
    "tests/test_browser_platform_executor.py",
    "tests/test_browser_tabs_and_reading.py",
    "tests/test_browser_page_observation.py",
    "tests/test_browser_login_session_form.py",
    "tests/test_browser_recovery.py",
    "tests/test_live_browser_acceptance.py",
    "tests/test_live_browser_engines.py",
]

LIVE_WINDOWS_TESTS = [
    "tests/test_live_notepad_ui_automation.py",
    "tests/test_live_file_explorer_workflow.py",
]

OFFICE_TESTS = ["tests/test_live_office_workflows.py"]


def run(label: str, tests: list[str]) -> int:
    print(f"\n=== {label} ===")
    return subprocess.run([sys.executable, "-m", "pytest", *tests, "-q"], check=False).returncode


def main() -> int:
    parser = argparse.ArgumentParser(description="Run staged, safe Nexus acceptance checks.")
    parser.add_argument("--browser", action="store_true", help="Include the local safe browser demo suite.")
    parser.add_argument("--live", action="store_true", help="Include safe live Notepad/File Explorer checks.")
    parser.add_argument("--office", action="store_true", help="Include Office COM checks; run only when Office is stable.")
    args = parser.parse_args()

    failures = run("Unit and safety checks", UNIT_TESTS)
    if args.browser:
        failures += run("Local browser demo checks", LOCAL_BROWSER_TESTS)
    if args.live:
        failures += run("Live Windows checks", LIVE_WINDOWS_TESTS)
    if args.office:
        failures += run("Office file-format checks", OFFICE_TESTS)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
