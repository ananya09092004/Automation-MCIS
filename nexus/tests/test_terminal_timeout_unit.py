"""Unit tests for TerminalController's bounded-timeout fix (P1.8).

TerminalController.run() previously had NO timeout at all -- a hung
command blocked the call (and whatever was waiting on it: the plan
loop, the single-worker HTTP bridge) forever, with no way to cancel it.

These tests run real, harmless, deterministic shell commands (echo,
sleep, exit codes) directly against TerminalController -- no desktop
app, no browser, no GUI, nothing interactive, nothing destructive. This
is the same "real but safe, local, deterministic" category as
test_file_overwrite_protection.py's direct filesystem tests, not a
`live` test: it never touches a real desktop/browser session and never
needs a display.
"""

import time

from desktop.terminal.controller import TerminalController


def test_a_fast_safe_command_still_returns_normally():
    result = TerminalController().run("echo nexus-ok", timeout_seconds=5)
    assert result.success
    assert "nexus-ok" in result.stdout
    assert result.timed_out is False


def test_a_nonzero_exit_code_is_reported_as_failure_not_a_timeout():
    result = TerminalController().run("exit 7", timeout_seconds=5)
    assert result.success is False
    assert result.return_code == 7
    assert result.timed_out is False


def test_a_hanging_command_is_terminated_at_the_timeout_instead_of_blocking_forever():
    started = time.monotonic()
    # sleep 30 would hang well past any reasonable test duration if the
    # timeout fix did not actually bound it.
    result = TerminalController().run("sleep 30", timeout_seconds=1)
    elapsed = time.monotonic() - started

    assert result.timed_out is True
    assert result.success is False
    assert elapsed < 10, f"a 1s timeout must not let the command run for {elapsed}s"


def test_the_exact_approved_command_string_is_what_actually_runs_not_a_substitute():
    # Defense-in-depth check: bounding execution time must never rewrite
    # or substitute the command itself -- the same string passed in is
    # the same string that executes.
    marker = "nexus-exact-command-check-39284"
    result = TerminalController().run(f"echo {marker}", timeout_seconds=5)
    assert marker in result.stdout


def test_a_timed_out_command_does_not_leave_its_child_process_tree_running():
    # The hung command spawns a grandchild (via a subshell) that would
    # keep running past the parent's death if only the top-level shell
    # process were killed, not the whole process group/tree.
    marker_file_cmd = "sh -c 'sleep 30 && echo should-not-happen'"
    result = TerminalController().run(marker_file_cmd, timeout_seconds=1)
    assert result.timed_out is True
    # Give the kill a brief moment, then confirm nothing from that
    # command is still alive by checking no leftover sleep process
    # referencing our marker is still around under this test's own
    # process tree (best-effort -- the important, deterministic
    # assertion is `timed_out is True` above; this is a secondary
    # sanity check that doesn't flake the test if pgrep is unavailable).
    import subprocess
    time.sleep(0.5)
    try:
        leftover = subprocess.run(
            ["pgrep", "-f", "sleep 30"], capture_output=True, text=True, timeout=5,
        )
        assert leftover.stdout.strip() == "", "a timed-out command must not leave its child process tree running"
    except FileNotFoundError:
        pass  # pgrep not available in this environment -- skip the secondary check
