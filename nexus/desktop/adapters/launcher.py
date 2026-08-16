import subprocess
import time
from pathlib import Path

import psutil


class Launcher:

    def launch(self, executable: Path) -> bool:

        try:

            process = subprocess.Popen(
                [str(executable)],
                shell=False
            )

            return self.wait_for_process(
                process.pid
            )

        except Exception:

            return False

    def wait_for_process(
        self,
        pid: int,
        timeout: int = 10
    ) -> bool:

        start = time.time()

        while time.time() - start < timeout:

            if psutil.pid_exists(pid):

                return True

            time.sleep(0.2)

        return False

    def close(
        self,
        process_name: str
    ) -> bool:

        closed = False

        for process in psutil.process_iter(
            ["pid", "name"]
        ):

            try:

                name = process.info["name"]

                if not name:
                    continue

                if process_name.lower() in name.lower():

                    process.terminate()

                    try:

                        process.wait(5)

                    except psutil.TimeoutExpired:

                        process.kill()

                    closed = True

            except Exception:

                pass

        return closed