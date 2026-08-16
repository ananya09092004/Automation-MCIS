"""
Common exceptions used across the Desktop Platform.
"""


class DesktopError(Exception):
    """Base exception for Desktop Platform."""
    pass


class PlatformNotSupportedError(DesktopError):
    """Current operating system is not supported."""
    pass


class ActionExecutionError(DesktopError):
    """Raised when an action fails during execution."""
    pass


class VerificationError(DesktopError):
    """Raised when action verification fails."""
    pass


class ResourceNotFoundError(DesktopError):
    """Raised when a required resource cannot be found."""
    pass


class InvalidParameterError(DesktopError):
    """Raised when invalid parameters are supplied."""
    pass


class PermissionDeniedError(DesktopError):
    """Raised when OS denies the requested action."""
    pass


class TimeoutError(DesktopError):
    """Raised when an operation exceeds the allowed timeout."""
    pass