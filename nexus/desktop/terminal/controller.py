import subprocess
from dataclasses import dataclass


@dataclass
class CommandResult:

    success: bool
    return_code: int
    stdout: str
    stderr: str


class TerminalController:

    def run(
        self,
        command: str,
        cwd: str | None = None
    ) -> CommandResult:

        try:

            process = subprocess.run(
                command,
                shell=True,
                cwd=cwd,
                capture_output=True,
                text=True
            )

            return CommandResult(

                success=process.returncode == 0,

                return_code=process.returncode,

                stdout=process.stdout,

                stderr=process.stderr

            )

        except Exception as e:

            return CommandResult(

                success=False,

                return_code=-1,

                stdout="",

                stderr=str(e)

            )

    def read_output(self, result: CommandResult) -> str:
        return result.stdout
