"""Rule-based Urdu (Perso-Arabic script) → Devanagari transliteration.

Stage 0 has no licensed Piper Urdu voice, so Urdu replies are spoken with a Hindi voice after
converting the script (spec §3). Urdu writing omits most short vowels, so this is approximate
by design: common words come from a lookup table, everything else from letter rules.
"""
from __future__ import annotations

import re

# Common words whose spelling the letter rules get wrong.
WORDS: dict[str, str] = {
    "میں": "में", "ہیں": "हैं", "ہے": "है", "نہیں": "नहीं", "یہ": "यह", "وہ": "वह", "کہ": "कि",
    "اور": "और", "کیا": "क्या", "کیوں": "क्यों", "شکریہ": "शुक्रिया", "برائے": "बराए", "مہربانی": "मेहरबानी",
    "آپ": "आप", "ہم": "हम", "جی": "जी", "ہاں": "हाँ", "نہ": "न", "اللہ": "अल्लाह", "انشاءاللہ": "इंशाअल्लाह",
    "السلام": "अस्सलाम", "علیکم": "अलैकुम", "وعلیکم": "वअलैकुम", "کل": "कल", "آج": "आज", "ابھی": "अभी",
    "پھر": "फिर", "بہت": "बहुत", "اچھا": "अच्छा", "ٹھیک": "ठीक", "دیں": "दें", "لیں": "लें", "کریں": "करें",
    "گے": "गे", "گی": "गी", "گا": "गा", "رہا": "रहा", "رہی": "रही", "رہے": "रहे", "کچھ": "कुछ", "سب": "सब",
    "آرڈر": "ऑर्डर", "ڈیلیوری": "डिलीवरी", "روپے": "रुपये", "قیمت": "क़ीमत", "وقت": "वक़्त", "دن": "दिन",
}

CONSONANTS: dict[str, str] = {
    "ب": "ब", "پ": "प", "ت": "त", "ٹ": "ट", "ث": "स", "ج": "ज", "چ": "च", "ح": "ह", "خ": "ख़",
    "د": "द", "ڈ": "ड", "ذ": "ज़", "ر": "र", "ڑ": "ड़", "ز": "ज़", "ژ": "ज़", "س": "स", "ش": "श",
    "ص": "स", "ض": "ज़", "ط": "त", "ظ": "ज़", "غ": "ग़", "ف": "फ़", "ق": "क़", "ک": "क", "ك": "क",
    "گ": "ग", "ل": "ल", "م": "म", "ن": "न", "ہ": "ह", "ه": "ह", "ة": "त",
}

# consonant + ھ (do-chashmi he) → aspirated letter
ASPIRATED: dict[str, str] = {
    "ک": "ख", "گ": "घ", "چ": "छ", "ج": "झ", "ٹ": "ठ", "ڈ": "ढ", "ت": "थ", "د": "ध", "پ": "फ", "ب": "भ", "ڑ": "ढ़",
}

MATRA = {"ا": "ा", "آ": "ा", "و": "ो", "ی": "ी", "ي": "ी", "ے": "े", "ى": "ी"}
INDEPENDENT = {"ا": "अ", "آ": "आ", "و": "ओ", "ی": "ई", "ي": "ई", "ے": "ए", "ى": "ई"}
DIACRITIC_MATRA = {"ِ": "ि", "ُ": "ु", "ٰ": "ा"}  # zer, pesh, khari zabar
INDEPENDENT_SHORT = {"ِ": "इ", "ُ": "उ", "َ": "अ"}
PUNCT = {"۔": "।", "،": ",", "؟": "?", "؛": ";", "٪": "%"}
DIGITS = {c: str(i) for i, c in enumerate("۰۱۲۳۴۵۶۷۸۹")} | {c: str(i) for i, c in enumerate("٠١٢٣٤٥٦٧٨٩")}
VIRAMA = "्"

_ARABIC = re.compile(r"[؀-ۿ]")
_WORD = re.compile(r"[؀-ۿٰ]+")


def _word(w: str) -> str:
    if w in WORDS:
        return WORDS[w]
    out: list[str] = []
    prev_cons: str | None = None  # Urdu letter of the previous consonant (None = last sound was a vowel / start)
    i, n = 0, len(w)
    while i < n:
        c = w[i]
        nxt = w[i + 1] if i + 1 < n else "\0"  # never "" — `"" in "abc"` is True
        start = not out

        if c == "ھ":  # aspirate previous consonant
            if prev_cons and prev_cons in ASPIRATED and out:
                out[-1] = ASPIRATED[prev_cons]
            else:
                out.append("ह")
            i += 1
            continue
        if c in CONSONANTS:
            # word-final ہ after a consonant is usually a vowel ending ("bachcha")
            if c in "ہه" and i == n - 1 and prev_cons:
                out.append("ा")
                prev_cons = None
            else:
                out.append(CONSONANTS[c])
                prev_cons = c
            i += 1
            continue
        if c == "ّ":  # shadda: double the previous consonant
            if prev_cons and out:
                out.append(VIRAMA + out[-1])
            i += 1
            continue
        if c == "ْ":  # sukun
            if prev_cons:
                out.append(VIRAMA)
            i += 1
            continue
        if c in DIACRITIC_MATRA:
            out.append(DIACRITIC_MATRA[c] if prev_cons else INDEPENDENT_SHORT.get(c, ""))
            prev_cons = None
            i += 1
            continue
        if c == "َ":  # zabar = inherent a
            if not prev_cons:
                out.append("अ")
            prev_cons = None
            i += 1
            continue
        if c == "ں" or c == "ں":  # noon ghunna → nasal
            out.append("ं")
            i += 1
            continue
        if c == "ئ":  # hamza carrier: vowel sound
            if nxt in "ےی":
                out.append("ए" if nxt == "ے" else "ई")
                i += 2
            else:
                out.append("इ")
                i += 1
            prev_cons = None
            continue
        if c in ("ء", "ع", "ً"):  # hamza / ain / tanween: carrier or silent
            if c == "ً":
                out.append("न")
            elif c == "ع" and start and nxt in "ای":
                out.append("इ" if nxt == "ی" else "आ")
                i += 1
                prev_cons = None
            i += 1
            continue
        if c in ("و", "ی", "ي", "ى"):
            if start:
                # word-initial و / ی are consonants (vah, yeh)
                out.append("व" if c == "و" else "य")
                prev_cons = c
            elif c != "و" and nxt in "اآ" and prev_cons:
                out.append("य")  # consonant + ی + ا → "ya" (tayyar, pyar)
                prev_cons = c
            elif prev_cons and prev_cons not in "وییيى":
                out.append(MATRA[c])
                prev_cons = None
            else:  # after a vowel: glide
                out.append("व" if c == "و" else "य")
                prev_cons = c
            i += 1
            continue
        if c in ("ا", "آ"):
            if start:
                if c == "ا" and nxt in "یي":
                    out.append("ए")
                    i += 2
                elif c == "ا" and nxt == "و":
                    out.append("ओ")
                    i += 2
                else:
                    out.append(INDEPENDENT[c])
                    i += 1
                prev_cons = None
                continue
            out.append(MATRA[c] if prev_cons else INDEPENDENT["آ"])
            prev_cons = None
            i += 1
            continue
        if c == "ے":
            out.append(MATRA[c] if prev_cons else INDEPENDENT[c])
            prev_cons = None
            i += 1
            continue
        i += 1  # any other Arabic-block mark: drop
    return "".join(out)


def urdu_to_devanagari(text: str) -> str:
    text = "".join(PUNCT.get(ch, DIGITS.get(ch, ch)) for ch in text)
    return _WORD.sub(lambda m: _word(m.group(0)), text)


def has_arabic_script(text: str) -> bool:
    return bool(_ARABIC.search(text))


TRANSLITERATORS = {"ur-deva": urdu_to_devanagari}
