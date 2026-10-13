from dataclasses import dataclass


@dataclass
class AppInfo:

    name: str

    aliases: tuple

    executable: str

    process: str

    window_titles: tuple


class AppRegistry:

    def __init__(self):

        self.apps = {

            "chrome": AppInfo(

                name="Google Chrome",

                aliases=(

                    "chrome",
                    "google chrome",
                    "browser"

                ),

                executable="chrome",

                process="chrome.exe",

                window_titles=(

                    "Google Chrome",

                    "Chrome"

                )

            ),

            "notepad": AppInfo(

                name="Notepad",

                aliases=(

                    "notepad",

                    "notes"

                ),

                executable="notepad",

                process="notepad.exe",

                window_titles=(

                    "Notepad",

                )

            ),

            "calculator": AppInfo(

                name="Calculator",

                aliases=(

                    "calculator",

                    "calc"

                ),

                executable="calc",

                process="CalculatorApp.exe",

                window_titles=(

                    "Calculator",

                )

            ),

            "vscode": AppInfo(

                name="Visual Studio Code",

                aliases=(

                    "vscode",

                    "vs code",

                    "code"

                ),

                executable="code",

                process="Code.exe",

                window_titles=(

                    "Visual Studio Code",

                )

            )

        }

    def find(self, name):

        name = name.lower()

        for app in self.apps.values():

            if name == app.name.lower():

                return app

            if name in app.aliases:

                return app

        return None