import psutil
import subprocess


class ProcessManager:

    def exists(
        self,
        process_name: str
    ) -> bool:

        process_name = process_name.lower()

        for process in psutil.process_iter(["name"]):

            try:

                name = process.info["name"]

                if name and process_name in name.lower():

                    return True

            except:

                pass

        return False

    def list_processes(self):

        result = []

        for process in psutil.process_iter(["pid", "name"]):

            try:

                result.append(

                    {

                        "pid": process.info["pid"],

                        "name": process.info["name"]

                    }

                )

            except:

                pass

        return result

    def kill(
        self,
        process_name: str | int
    ) -> bool:

        if isinstance(process_name, int):
            try:
                psutil.Process(process_name).kill()
                return True
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                return False

        process_name = process_name.lower()

        for process in psutil.process_iter(["name"]):

            try:

                name = process.info["name"]

                if name and process_name in name.lower():

                    process.kill()

                    return True

            except:

                pass

        return False

    def start(self, command: str) -> int | None:
        try:
            return subprocess.Popen(command, shell=True).pid
        except OSError:
            return None

    def restart(self, process_name: str, command: str | None = None) -> int | None:
        self.kill(process_name)
        return self.start(command or process_name)

    def pid(
        self,
        process_name: str
    ):

        process_name = process_name.lower()

        for process in psutil.process_iter(["pid", "name"]):

            try:

                name = process.info["name"]

                if name and process_name in name.lower():

                    return process.info["pid"]

            except:

                pass

        return None
