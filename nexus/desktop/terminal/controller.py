import os
import signal
import subprocess
import sys
from dataclasses import dataclass

# P1.8 -- previously `run` called subprocess.run(..., shell=True) with NO
# timeout at all. A command that hangs (waiting on stdin, a long-running
# server started by mistake, a genuine infinite loop) blocked this call
# forever -- and with it, whatever was waiting on the result: the plan
# loop (taskPlanner.js's runLoop awaiting the Nexus HTTP bridge), and the
# HTTP bridge itself, which only has a single-worker ThreadPoolExecutor
# (see nexus/api_server.py), so one stuck terminal command could starve
# every other action behind it. There was also no way to cancel a command
# once started. This now runs with a bounded timeout and actively kills
# the whole process tree (not just the shell) when that timeout fires.
DEFAULT_TERMINAL_TIMEOUT_SECONDS = 30


@dataclass
class CommandResult:

    success: bool
    return_code: int
    stdout: str
    stderr: str
    timed_out: bool = False


class TerminalController:

    def run(
        self,
        command: str,
        cwd: str | None = None,
        timeout_seconds: float = DEFAULT_TERMINAL_TIMEOUT_SECONDS,
    ) -> CommandResult:
        # The exact command string passed in is still the exact command
        # executed -- nothing here rewrites, substitutes, or re-plans it.
        # Bounding execution time and killing a runaway process tree is
        # purely about not hanging the caller forever; it does not change
        # WHAT gets run, only how long it's allowed to run unattended.
        popen_kwargs = {}
        if sys.platform == "win32":
            # A new process group so the whole tree spawned by the shell
            # (not just the shell process itself) can be terminated
            # together if this command times out.
            popen_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            # A new session (setsid) so os.killpg() below can reach every
            # process the shell spawned, not just the shell itself.
            popen_kwargs["start_new_session"] = True

        try:
            process = subprocess.Popen(
                command,
                shell=True,
                cwd=cwd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                **popen_kwargs,
            )
        except Exception as e:
            return CommandResult(success=False, return_code=-1, stdout="", stderr=str(e))

        try:
            stdout, stderr = process.communicate(timeout=timeout_seconds)
            return CommandResult(
                success=process.returncode == 0,
                return_code=process.returncode,
                stdout=stdout or "",
                stderr=stderr or "",
            )
        except subprocess.TimeoutExpired:
            self._terminate_tree(process)
            try:
                # Give the kill a moment to actually land and drain
                # whatever partial output already exists.
                stdout, stderr = process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                stdout, stderr = process.communicate()
            return CommandResult(
                success=False,
                return_code=-1,
                stdout=stdout or "",
                stderr=(stderr or "") + (
                    f"\n[nexus] Command exceeded the {timeout_seconds}s limit "
                    "and was terminated."
                ),
                timed_out=True,
            )
        except Exception as e:
            self._terminate_tree(process)
            return CommandResult(success=False, return_code=-1, stdout="", stderr=str(e))

    @staticmethod
    def _terminate_tree(process: subprocess.Popen) -> None:
        """Best-effort kill of the command AND everything it spawned."""
        try:
            if sys.platform == "win32":
                subprocess.run(
                    ["taskkill", "/F", "/T", "/PID", str(process.pid)],
                    capture_output=True,
                )
            else:
                os.killpg(process.pid, signal.SIGKILL)
        except Exception:
            try:
                process.kill()
            except Exception:
                pass

    def read_output(self, result: CommandResult) -> str:
        return result.stdout
