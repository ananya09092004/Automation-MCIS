from langdetect import detect, DetectorFactory, LangDetectException
import re

DetectorFactory.seed = 0

ACK_PHRASES = {
    "hi": "Main kar rahi hoon.",
    "en": "Working on it.",
    "es": "Trabajando en ello.",
    "fr": "J'y travaille.",
    "de": "Ich arbeite daran.",
    "pt": "Estou trabalhando nisso.",
    "ta": "Naan seiven.",
    "te": "Nenu chestunnanu.",
    "bn": "Ami korchi.",
    "mr": "Mi karat aahe.",
    "gu": "Hun karu chu.",
}

# All of Nexus's OTHER spoken responses (not just the ack phrase). Only
# "en" and "hi" are provided -- "hi" is used as the default voice/
# personality (matches how Nexus already spoke before this), and "en" is
# used specifically when the user's command is detected as English, so
# an English command gets an English reply instead of Hinglish.
RESPONSE_PHRASES = {
    "en": {
        "done": "Done.",
        "not_done": "Couldn't do that.",
        "not_done_detail": "Couldn't do that. {detail}",
        "plan_complete": "All done. {detail}",
        "plan_error": "Couldn't finish that.",
        "chat_fallback": "Sorry, I didn't catch that.",
        "approval_needed": "This needs approval first.",
        "tried_unsure": "I tried, but I'm not sure it worked.",
        "ai_task_done": "Done, your task is complete.",
        "error_generic": "Something went wrong: {detail}",
        "confirm_transcript": "I heard: {text}. Is that right?",
        "confirm_suffix": " Say yes or no.",
        "discarded": "Okay, please say that again.",
        "cancelled": "Okay, cancelled.",
        "grant_failed": "Couldn't save that approval, please try again.",
        "connection_failed": "Couldn't connect to the MCIS backend. Please check it's running.",
        "sleep": "Okay, going to sleep.",
        "goodbye": "Goodbye.",
        "emergency_stop": "Emergency stop. Everything's been halted.",
        "resumed": "Automation resumed. You're good to go.",
        "trouble_hearing": "I'm having trouble hearing you. Please type into the MCIS app, or say 'Hey Nexus' again in a bit.",
        "retry": "Sorry, please say that again.",
    },
    "hi": {
        "done": "Ho gaya.",
        "not_done": "Nahi ho paya.",
        "not_done_detail": "Nahi ho paya. {detail}",
        "plan_complete": "Poora kaam ho gaya. {detail}",
        "plan_error": "Kaam poora nahi ho paya.",
        "chat_fallback": "Samjha nahi, dobara boliye.",
        "approval_needed": "Isse karne ke liye pehle approval chahiye.",
        "tried_unsure": "Try to kiya, par confirm nahi hai.",
        "ai_task_done": "Ho gaya, tumhara task complete hai.",
        "error_generic": "Error aaya: {detail}",
        "confirm_transcript": "Maine suna: {text}. Sahi hai?",
        "confirm_suffix": " Haan ya nahi boliye.",
        "discarded": "Theek hai, phir se boliye.",
        "cancelled": "Theek hai, cancel kar diya.",
        "grant_failed": "Approval save nahi ho payi, dobara try karo.",
        "connection_failed": "MCIS backend se connect nahi ho paya. Check karo ki backend chal raha hai.",
        "sleep": "Okay. Main sleep mode mein ja rahi hoon.",
        "goodbye": "Goodbye.",
        "emergency_stop": "Emergency stop. Sab ruk gaya.",
        "resumed": "Automation phir se chalu ho gaya. Ab kaam kar sakte ho.",
        "trouble_hearing": "Lagta hai sunne mein problem ho rahi hai. MCIS app mein type kar dijiye, ya thodi der baad 'Hey Nexus' bolke phir try kariye.",
        "retry": "Sorry, dobara boliye.",
    },
}


def detect_language(text: str) -> str:
    """Best-effort language classifier for short spoken commands.

    langdetect (statistical, trained on prose) turns out to be
    unreliable even on 5+ word imperative command-style phrases --
    e.g. "send an email to john" gets misclassified as Finnish. Voice
    commands are a different register (short, imperative, proper-noun
    heavy) than what langdetect expects, so it isn't used here at all.
    Instead: if the text contains any common romanized Hindi/Hinglish
    word, it's Hindi/Hinglish; otherwise it's treated as English. This
    matches real usage -- a command with no Hindi/Hinglish words in it
    is essentially always English.

    Defaults to 'hi' (Nexus's default voice/personality) only when the
    text is empty.
    """
    text = (text or "").strip()
    if not text:
        return "hi"

    return "hi" if _has_hinglish_markers(text) else "en"


_HINGLISH_MARKERS = {
    "hai", "hain", "nahi", "nahin", "kya", "kaise", "karo", "kijiye",
    "kijiyega", "kholo", "khol", "kholiye", "band", "kardo", "chahiye",
    "mujhe", "tumhe", "aapko", "bhi", "aur", "ki", "ke", "ko", "se",
    "mein", "wala", "wali", "wale", "bolo", "suno", "sun", "bata",
    "batao", "dikhao", "dekho", "jao", "jaldi", "abhi", "phir", "fir",
    "toh", "haan", "han", "acha", "theek", "thik", "yaar", "bhai",
    "krdo", "krna", "hoga", "hogi", "raha", "rahi", "rha", "rhi",
    "diya", "dijiye", "chalao", "chalu", "karna", "kardo", "kro",
    "le", "lo", "lena", "leke", "dikha", "ye", "yeh", "woh", "wo",
}


def _has_hinglish_markers(text: str) -> bool:
    words = re.findall(r"[a-zA-Z']+", text.lower())
    return any(word in _HINGLISH_MARKERS for word in words)


def detect_ack_phrase(command: str) -> str:
    text = command.strip()
    if not text:
        return ACK_PHRASES["hi"]
    try:
        lang = detect(text)
    except LangDetectException:
        lang = "hi"
    return ACK_PHRASES.get(lang, ACK_PHRASES["hi"])


def get_phrase(key: str, lang: str, **kwargs) -> str:
    """Look up one of Nexus's spoken response phrases in the right
    language. Falls back to Hindi/Hinglish (the default voice) for any
    language other than English, and to an empty string if the key is
    somehow missing from both (should not normally happen)."""
    lang_key = "en" if lang == "en" else "hi"
    phrase = RESPONSE_PHRASES.get(lang_key, {}).get(key) or RESPONSE_PHRASES["hi"].get(key, "")
    if kwargs:
        try:
            return phrase.format(**kwargs)
        except Exception:
            return phrase
    return phrase