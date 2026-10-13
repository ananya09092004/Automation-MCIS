class ApplicationManagerError(Exception):
    """Base exception for Application Manager."""


class ApplicationNotFoundError(ApplicationManagerError):
    """Application was not found."""


class InstallationCancelledError(ApplicationManagerError):
    """User cancelled installation."""


class InstallationFailedError(ApplicationManagerError):
    """Installation failed."""