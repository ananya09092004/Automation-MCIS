import winreg
from pathlib import Path


class WindowsRegistry:

    UNINSTALL_PATHS = [
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
    ]

    APP_PATHS = [
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths",
        r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths",
    ]

    HIVES = [
        winreg.HKEY_LOCAL_MACHINE,
        winreg.HKEY_CURRENT_USER,
    ]

    def find(self, app_name: str):

        query = app_name.strip().lower()

        if not query:
            return None

        # --------------------------------------------------
        # 1. Windows App Paths
        # --------------------------------------------------
        # This is important for applications such as
        # Microsoft Word, Excel, etc.
        #
        # Example:
        # WINWORD.EXE -> C:\...\WINWORD.EXE
        # --------------------------------------------------

        for hive in self.HIVES:

            for app_paths in self.APP_PATHS:

                try:
                    root = winreg.OpenKey(
                        hive,
                        app_paths
                    )
                except Exception:
                    continue

                try:
                    count = winreg.QueryInfoKey(root)[0]
                except Exception:
                    continue

                for i in range(count):

                    try:
                        sub_name = winreg.EnumKey(
                            root,
                            i
                        )

                        key = winreg.OpenKey(
                            root,
                            sub_name
                        )

                        executable_name = (
                            sub_name
                            .lower()
                            .replace(".exe", "")
                        )

                        # Match the requested name against
                        # the executable name.
                        if (
                            query in executable_name
                            or executable_name in query
                        ):

                            try:
                                executable, _ = winreg.QueryValueEx(
                                    key,
                                    ""
                                )
                            except Exception:
                                executable = ""

                            if executable:

                                executable = executable.strip().strip('"')

                                path = Path(
                                    executable
                                )

                                if path.exists():

                                    return path

                    except Exception:
                        continue

        # --------------------------------------------------
        # 2. Common Windows executable aliases
        # --------------------------------------------------
        # These are names users naturally say, while Windows
        # executable names are different.
        # --------------------------------------------------

        aliases = {

            "ms word": "WINWORD.EXE",
            "microsoft word": "WINWORD.EXE",
            "word": "WINWORD.EXE",

            "ms excel": "EXCEL.EXE",
            "microsoft excel": "EXCEL.EXE",
            "excel": "EXCEL.EXE",

            "ms powerpoint": "POWERPNT.EXE",
            "microsoft powerpoint": "POWERPNT.EXE",
            "powerpoint": "POWERPNT.EXE",

            "ms outlook": "OUTLOOK.EXE",
            "microsoft outlook": "OUTLOOK.EXE",
            "outlook": "OUTLOOK.EXE",
        }

        executable_alias = aliases.get(query)

        if executable_alias:

            for hive in self.HIVES:

                for app_paths in self.APP_PATHS:

                    try:
                        key_path = (
                            app_paths
                            + "\\"
                            + executable_alias
                        )

                        key = winreg.OpenKey(
                            hive,
                            key_path
                        )

                        executable, _ = winreg.QueryValueEx(
                            key,
                            ""
                        )

                        if executable:

                            executable = (
                                executable
                                .strip()
                                .strip('"')
                            )

                            path = Path(
                                executable
                            )

                            if path.exists():
                                return path

                    except Exception:
                        continue

        # --------------------------------------------------
        # 3. Installed applications
        # --------------------------------------------------

        for hive in self.HIVES:

            for uninstall in self.UNINSTALL_PATHS:

                try:
                    root = winreg.OpenKey(
                        hive,
                        uninstall
                    )
                except Exception:
                    continue

                try:
                    count = winreg.QueryInfoKey(root)[0]
                except Exception:
                    continue

                for i in range(count):

                    try:
                        sub = winreg.EnumKey(
                            root,
                            i
                        )

                        key = winreg.OpenKey(
                            root,
                            sub
                        )

                        display, _ = winreg.QueryValueEx(
                            key,
                            "DisplayName"
                        )

                        display = str(
                            display
                        ).lower()

                        if query not in display:
                            continue

                        # -----------------------------
                        # DisplayIcon
                        # -----------------------------

                        try:
                            icon, _ = winreg.QueryValueEx(
                                key,
                                "DisplayIcon"
                            )
                        except Exception:
                            icon = ""

                        if icon:

                            icon = (
                                str(icon)
                                .split(",")[0]
                                .strip()
                                .strip('"')
                            )

                            path = Path(icon)

                            if path.exists():

                                return path

                        # -----------------------------
                        # InstallLocation
                        # -----------------------------

                        try:
                            location, _ = winreg.QueryValueEx(
                                key,
                                "InstallLocation"
                            )
                        except Exception:
                            location = ""

                        if location:

                            folder = Path(
                                str(location).strip().strip('"')
                            )

                            if folder.exists():

                                # Prefer an executable whose
                                # name resembles the requested app.
                                candidates = list(
                                    folder.glob("*.exe")
                                )

                                for exe in candidates:

                                    if query.replace(
                                        " ",
                                        ""
                                    ) in exe.stem.lower().replace(
                                        " ",
                                        ""
                                    ):

                                        return exe

                                # Fallback only if exactly
                                # one executable exists.
                                if len(candidates) == 1:
                                    return candidates[0]

                    except Exception:
                        continue

        # --------------------------------------------------
        # 4. PATH lookup
        # --------------------------------------------------

        import shutil

        candidates = [
            query,
            query.replace(" ", ""),
            query + ".exe",
        ]

        for candidate in candidates:

            found = shutil.which(
                candidate
            )

            if found:

                return Path(found)

        return None