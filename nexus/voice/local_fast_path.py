"""
Local, in-process fast path for simple app-control voice commands.

Every command previously went through the SAME path: HTTP to MCIS backend
-> (fastPath.js OR Gemini classifyIntent) -> HTTP to nexus/api_server.py
-> desktop/browser executor. For something as simple as "open chrome" or
"switch to notepad" that's 2 network hops and, when fastPath.js doesn't
match, an LLM call -- all for an action nexus/desktop/app_controller can
just do directly, in this same Python process, in a few milliseconds.

This module tries to handle simple app-control commands ENTIRELY locally
-- no MCIS, no LLM, no HTTP. Anything it doesn't recognize returns None,
and voice_controller.py falls through to the existing MCIS path exactly
as before. This is purely additive: nothing about the MCIS/Nexus HTTP
path, memory, auth, browser automation, or multi-step planning changes
or is bypassed for anything this module doesn't explicitly handle.

App resolution is NOT a hardcoded whitelist -- it goes through the same
dynamic AppController (Windows registry discovery + process/window
lookup) that the MCIS/Nexus path already uses for open_app/switch_to_app/
close_app, so this stays consistent with "app switching must remain
dynamic."
"""

import re

_OPEN_RE = re.compile(r"^(?:open|launch|start)\s+(?:a\s+)?(.+?)\s*$", re.I)
_SWITCH_RE = re.compile(r"^(?:switch to|go back to|go to|bring up)\s+(.+?)\s*$", re.I)
_CLOSE_RE = re.compile(r"^close\s+(.+?)\s*$", re.I)
_MINIMIZE_RE = re.compile(r"^minimize\s+(.+?)\s*$", re.I)
_MAXIMIZE_RE = re.compile(r"^maximize\s+(.+?)\s*$", re.I)
_NEW_WINDOW_RE = re.compile(r"^open\s+(?:a\s+)?new\s+window(?:\s+(?:in|of|for)\s+(.+?))?\s*$", re.I)
_NEW_WINDOW_APP_FIRST_RE = re.compile(r"^open\s+(?:a\s+)?new\s+(.+?)\s+window\s*$", re.I)
_NEW_TAB_RE = re.compile(r"^(?:open\s+)?(?:a\s+)?new\s+tab(?:\s+(?:in|of)\s+(.+?))?\s*$", re.I)
_NEW_TAB_APP_FIRST_RE = re.compile(r"^(?:open\s+)?(?:a\s+)?new\s+(.+?)\s+tab\s*$", re.I)

# Deliberately small -- these are commands where "just do the OS action"
# is unambiguous and safe. Anything even slightly ambiguous (a bare
# app name with no verb, a compound/multi-step phrasing, "and"/"then")
# is left for the MCIS/LLM path, which has real intent classification
# and planning behind it.
_LAST_FOCUSED_APP = {"name": None}


def _controller():
    # Imported lazily so this module (and voice_controller.py, which
    # imports it) stays importable even in environments without the
    # Windows-only desktop deps (e.g. this repo's own test collection),
    # exactly like the rest of nexus/desktop already assumes Windows.
    from desktop.app_controller.controller import AppController
    return AppController()


def _keyboard():
    from desktop.keyboard.controller import KeyboardController
    return KeyboardController()


def try_execute(command: str):
    """Attempt to handle `command` entirely locally.

    Returns a spoken-response string on success/failure of the local
    action (so the caller still gets a real result to speak), or None if
    this command isn't one of the simple patterns handled here -- the
    caller should fall through to the existing MCIS path unchanged.
    """
    text = (command or "").strip()
    if not text:
        return None

    match = _NEW_WINDOW_RE.match(text)
    if match:
        return _new_window(match.group(1))

    match = _NEW_WINDOW_APP_FIRST_RE.match(text)
    if match:
        return _new_window(match.group(1))

    match = _NEW_TAB_RE.match(text)
    if match:
        return _new_tab(match.group(1))

    match = _NEW_TAB_APP_FIRST_RE.match(text)
    if match:
        return _new_tab(match.group(1))

    match = _SWITCH_RE.match(text)
    if match:
        return _switch_to(match.group(1))

    match = _CLOSE_RE.match(text)
    if match:
        return _close(match.group(1))

    match = _MINIMIZE_RE.match(text)
    if match:
        return _minimize(match.group(1))

    match = _MAXIMIZE_RE.match(text)
    if match:
        return _maximize(match.group(1))

    match = _OPEN_RE.match(text)
    if match:
        return _open(match.group(1))

    return None


def _clean_app_name(raw: str) -> str:
    return re.sub(r"\b(please|app|application|window)\b", "", raw, flags=re.I).strip()


# A handful of generic UI nouns that are never realistically the name of
# an installed application. Without this guard, the generic open/close/
# switch/minimize/maximize patterns above are too greedy: "open a fresh
# tab", "start another tab", "close another tab" etc. would capture
# "fresh tab"/"another tab" as if it were a literal app name and try to
# launch/close an app called that -- which fails ("fresh tab nahi mil
# paya") and, critically, SWALLOWS the command entirely (this module
# returning a non-None string means voice_controller.py never falls
# through to MCIS), so the correct new_tab intent never even reaches
# the real semantic layer that would have understood it fine. This is
# not a phrase dictionary -- it's a short list of generic nouns no real
# app is named, used only to defer ambiguous cases to MCIS rather than
# guess wrong locally.
_GENERIC_UI_NOUNS = {"tab", "tabs", "window", "windows", "document", "documents",
                      "doc", "docs", "file", "files", "page", "pages"}


def _looks_like_a_real_app_name(name: str) -> bool:
    words = name.lower().split()
    return bool(words) and words[-1] not in _GENERIC_UI_NOUNS


def _open(raw_name: str):
    name = _clean_app_name(raw_name)
    if not name or not _looks_like_a_real_app_name(name):
        return None
    try:
        controller = _controller()
        ok = controller.open_app(name)
    except Exception as error:
        print(f"[Nexus Voice] Local fast-path open_app failed, will not fall back to MCIS for this: {error}")
        return f"{name} open karne mein dikkat aa gayi."
    if ok:
        _LAST_FOCUSED_APP["name"] = name
        return "Done."
    return f"{name} nahi mil paya."


def _switch_to(raw_name: str):
    name = _clean_app_name(raw_name)
    if not name or not _looks_like_a_real_app_name(name):
        return None
    try:
        controller = _controller()
        ok = controller.switch_to_app(name)
        if not ok:
            # Not currently open -- "switch to X" when X isn't running
            # is reasonably treated as "open X" instead of just failing.
            ok = controller.open_app(name)
    except Exception as error:
        print(f"[Nexus Voice] Local fast-path switch_to_app failed: {error}")
        return f"{name} pe switch nahi ho paaya."
    if ok:
        _LAST_FOCUSED_APP["name"] = name
        return "Done."
    return f"{name} nahi mil paya."


def _close(raw_name: str):
    name = _clean_app_name(raw_name)
    if not name or not _looks_like_a_real_app_name(name):
        return None
    try:
        controller = _controller()
        ok = controller.close_app(name)
    except Exception as error:
        print(f"[Nexus Voice] Local fast-path close_app failed: {error}")
        return f"{name} band karne mein dikkat aa gayi."
    return "Done." if ok else f"{name} band nahi ho paaya."


def _minimize(raw_name: str):
    name = _clean_app_name(raw_name)
    if not name or not _looks_like_a_real_app_name(name):
        return None
    try:
        ok = _controller().minimize_app(name)
    except Exception as error:
        print(f"[Nexus Voice] Local fast-path minimize_app failed: {error}")
        return None
    return "Done." if ok else f"{name} minimize nahi ho paaya."


def _maximize(raw_name: str):
    name = _clean_app_name(raw_name)
    if not name or not _looks_like_a_real_app_name(name):
        return None
    try:
        ok = _controller().maximize_app(name)
    except Exception as error:
        print(f"[Nexus Voice] Local fast-path maximize_app failed: {error}")
        return None
    return "Done." if ok else f"{name} maximize nahi ho paaya."


def _resolve_target_app(raw_name: str):
    name = _clean_app_name(raw_name or "")
    return name or _LAST_FOCUSED_APP["name"]


def _new_window(raw_name: str):
    name = _resolve_target_app(raw_name)
    if not name:
        return None  # no app named and nothing focused recently -- ambiguous, let MCIS/LLM handle it
    try:
        controller = _controller()
        if not controller.is_running(name):
            # Nothing open yet -- launching IS already a new window, no
            # extra hotkey needed (and there's no existing window to
            # send Ctrl+N to yet).
            ok = controller.open_app(name)
        else:
            controller.switch_to_app(name)
            ok = _keyboard().hotkey("ctrl", "n")
    except Exception as error:
        print(f"[Nexus Voice] Local fast-path new_window failed: {error}")
        return f"{name} ki nayi window nahi khul paayi."
    if ok:
        _LAST_FOCUSED_APP["name"] = name
        return "Done."
    return f"{name} ki nayi window nahi khul paayi."


def _new_tab(raw_name: str):
    name = _resolve_target_app(raw_name)
    if not name:
        return None
    try:
        controller = _controller()
        if not controller.is_running(name):
            ok = controller.open_app(name)  # opening fresh already gives one tab
        else:
            controller.switch_to_app(name)
            ok = _keyboard().hotkey("ctrl", "t")
    except Exception as error:
        print(f"[Nexus Voice] Local fast-path new_tab failed: {error}")
        return f"{name} mein naya tab nahi khul paaya."
    if ok:
        _LAST_FOCUSED_APP["name"] = name
        return "Done."
    return f"{name} mein naya tab nahi khul paaya."