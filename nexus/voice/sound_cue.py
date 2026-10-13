"""
Short beep played right after "Hey Nexus" is detected, so the user knows
exactly when to start speaking instead of guessing and risking the first
word or two getting clipped.

Windows-only sound (winsound is stdlib, no extra dependency needed --
this matches the target platform for the packaged product). On any other
platform this silently does nothing rather than raising, so it never
breaks local dev/testing on Mac/Linux.
"""

import sys


def play_wake_beep():
    if sys.platform != "win32":
        return
    try:
        import winsound
        winsound.Beep(880, 120)
    except Exception as error:
        print(f"[Nexus Voice] Wake beep skipped: {error}")