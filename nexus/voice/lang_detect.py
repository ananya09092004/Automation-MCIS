from langdetect import detect, DetectorFactory, LangDetectException
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

def detect_ack_phrase(command: str) -> str:
    text = command.strip()
    if not text:
        return ACK_PHRASES["en"]
    try:
        lang = detect(text)
    except LangDetectException:
        lang = "en"
    return ACK_PHRASES.get(lang, ACK_PHRASES["en"])
