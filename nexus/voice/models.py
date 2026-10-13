from dataclasses import dataclass


@dataclass
class VoiceCommand:

    raw_text: str

    cleaned_text: str

    wake_word_detected: bool

    confidence: float