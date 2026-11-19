/**
 * Cheap language guess from script + common words (no model). Used as a second opinion next to
 * the model's own answer, so `/v1/translate` can say how sure it is about the source language.
 * Covers the languages MesgAI needs first: ur, ur-Latn, ar, hi, en, es, pt, tr.
 */
const URDU_ONLY = /[ٹڈڑںےھگکپچژۓ]/;
const ARABIC_SCRIPT = /[؀-ۿ]/g;
const DEVANAGARI = /[ऀ-ॿ]/g;
const LATIN = /[A-Za-zÀ-ÿğşıİçöü]/g;

const STOP: Record<string, string[]> = {
  'ur-Latn': ['hai', 'hain', 'aap', 'ap', 'kya', 'nahi', 'nahin', 'mein', 'main', 'ka', 'ki', 'ke', 'ko', 'se', 'ho', 'jayega', 'jayegi', 'kar', 'karein', 'karen', 'theek', 'ji', 'shukriya', 'aur', 'bhi', 'kal', 'abhi', 'sakta', 'sakte', 'sakti', 'raha', 'rahi', 'hum', 'mera', 'meri', 'aapka', 'aapki', 'apka', 'wala', 'kitne', 'kitni', 'hoga', 'hogi', 'liye', 'tak', 'bhai', 'acha', 'achha', 'haan'],
  en: ['the', 'is', 'are', 'you', 'your', 'to', 'and', 'of', 'for', 'we', 'will', 'thank', 'thanks', 'please', 'our', 'it', 'on', 'at', 'an', 'be', 'can', 'with', 'open', 'from', 'what', 'when', 'how', 'do', 'my', 'i'],
  es: ['el', 'la', 'los', 'las', 'que', 'y', 'en', 'por', 'para', 'es', 'está', 'gracias', 'usted', 'su', 'hola', 'con', 'un', 'una', 'mañana', 'pedido', 'cuánto', 'puede', 'pueden'],
  pt: ['os', 'as', 'que', 'e', 'em', 'para', 'é', 'está', 'obrigado', 'obrigada', 'você', 'vocês', 'seu', 'sua', 'olá', 'não', 'com', 'um', 'uma', 'amanhã', 'pedido', 'quanto', 'pode'],
  tr: ['ve', 'bir', 'bu', 'için', 'ne', 'mi', 'mı', 'var', 'yok', 'teşekkürler', 'merhaba', 'yarın', 'sipariş', 'ben', 'siz', 'nasıl', 'kadar', 'evet', 'hayır'],
};

export interface LangGuess {
  /** BCP-47 code, or null when there is too little evidence (e.g. "ok", "👍", "123"). */
  code: string | null;
  /** 0–1: how clear the evidence is. Script-based guesses are strong, word-based ones weaker. */
  strength: number;
}

export function guessLanguage(text: string): LangGuess {
  const arabic = (text.match(ARABIC_SCRIPT) ?? []).length;
  const deva = (text.match(DEVANAGARI) ?? []).length;
  const latin = (text.match(LATIN) ?? []).length;
  if (arabic > latin && arabic >= deva && arabic >= 2) return { code: URDU_ONLY.test(text) ? 'ur' : 'ar', strength: URDU_ONLY.test(text) ? 0.95 : 0.8 };
  if (deva > latin && deva >= 2) return { code: 'hi', strength: 0.95 };
  const words = text.toLowerCase().match(/[a-zà-ÿğşıçöü]+/g) ?? [];
  if (words.length === 0) return { code: null, strength: 0 };
  let best: string | null = null;
  let bestScore = 0;
  let second = 0;
  for (const [lang, list] of Object.entries(STOP)) {
    const set = new Set(list);
    const score = words.filter((w) => set.has(w)).length;
    if (score > bestScore) {
      second = bestScore;
      best = lang;
      bestScore = score;
    } else if (score > second) second = score;
  }
  if (!best) return { code: null, strength: 0 };
  // share of words that are known function words, reduced when another language is close
  const strength = Math.min(0.9, (bestScore / words.length) * 2) * (1 - second / (bestScore + second));
  return { code: best, strength: Math.round(strength * 100) / 100 };
}

/** Normalises a BCP-47 tag to the form used in config (`ur-latn` → `ur-Latn`, `ar-eg` → `ar-EG`). */
export function canonicalTag(tag: string): string {
  return tag
    .trim()
    .replace(/_/g, '-')
    .split('-')
    .map((p, i) => (i === 0 ? p.toLowerCase() : p.length === 4 ? p[0]!.toUpperCase() + p.slice(1).toLowerCase() : p.toUpperCase()))
    .join('-');
}

/** Primary language subtag: `ur-Latn` → `ur`, `ar-EG` → `ar`. */
export const baseLang = (tag: string): string => tag.split('-')[0]!.toLowerCase();

/** Same language for "no translation needed" purposes: script must match (`ur` ≠ `ur-Latn`), region may differ. */
export function sameLanguage(a: string, b: string): boolean {
  const script = (t: string): string => t.split('-').find((p) => p.length === 4)?.toLowerCase() ?? '';
  return baseLang(a) === baseLang(b) && script(a) === script(b);
}
