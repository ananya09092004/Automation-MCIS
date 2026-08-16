import platform


def current_platform() -> str:
    """
    Returns current operating system.

    Example:
        Windows
        Linux
        Darwin
    """
    return platform.system()


def is_windows() -> bool:
    return current_platform() == "Windows"


def is_linux() -> bool:
    return current_platform() == "Linux"


def is_macos() -> bool:
    return current_platform() == "Darwin"