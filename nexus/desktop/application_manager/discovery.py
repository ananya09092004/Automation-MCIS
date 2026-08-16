from .registry import RegistryDiscovery
from .models import ApplicationInfo


class ApplicationDiscovery:

    def __init__(self):

        self.registry = RegistryDiscovery()

    def discover(self, app_name: str):

        executable = self.registry.find(app_name)

        if executable:

            return ApplicationInfo(

                name=app_name,

                executable=executable,

                installed=True,

                install_location=executable.parent,

                source="SYSTEM"

            )

        return ApplicationInfo(

            name=app_name,

            executable=None,

            installed=False

        )