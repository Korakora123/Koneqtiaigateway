"""Language → Chatterbox Multilingual language_id map for the voice-clone service (Stage 2).

Moved from mesgai-brain/voice-engine with `arabic` and `turkish` added (spec §2).
Urdu has no native Chatterbox voice: speak it via Hindi after Urdu→Devanagari transliteration
(same approach as services/tts/app/translit.py).
"""

LANGUAGE_MAP: dict[str, dict[str, str]] = {
    "english":    {"code": "en", "chatterbox": "en"},
    "hindi":      {"code": "hi", "chatterbox": "hi"},
    "urdu":       {"code": "ur", "chatterbox": "hi", "transliterate": "ur-deva"},
    "arabic":     {"code": "ar", "chatterbox": "ar"},
    "turkish":    {"code": "tr", "chatterbox": "tr"},
    "spanish":    {"code": "es", "chatterbox": "es"},
    "portuguese": {"code": "pt", "chatterbox": "pt"},
}

BY_CODE = {v["code"]: {"name": k, **v} for k, v in LANGUAGE_MAP.items()}


def resolve(language: str) -> dict[str, str]:
    """Accepts a name ('arabic') or ISO code ('ar')."""
    key = language.strip().lower()
    if key in LANGUAGE_MAP:
        return {"name": key, **LANGUAGE_MAP[key]}
    if key in BY_CODE:
        return BY_CODE[key]
    raise KeyError(f"voice-clone language not supported: {language}")
