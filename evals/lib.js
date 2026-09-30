// Pure helpers for the eval runner (unit-tested in test/).

const URDU_ONLY = /[ٹڈڑںےھگکپچژۓ]/;
const ARABIC_SCRIPT = /[؀-ۿ]/g;
const DEVANAGARI = /[ऀ-ॿ]/g;
const LATIN = /[A-Za-zÀ-ÿ]/g;

const STOP = {
  'roman-ur': ['hai', 'hain', 'aap', 'ap', 'kya', 'nahi', 'nahin', 'mein', 'main', 'ka', 'ki', 'ke', 'ko', 'se', 'ho', 'jayega', 'jayegi', 'kar', 'karein', 'karen', 'theek', 'ji', 'shukriya', 'aur', 'bhi', 'kal', 'abhi', 'sakta', 'sakte', 'raha', 'rahi', 'hum', 'hamari', 'aapka', 'aapki', 'apki', 'wala', 'waqt', 'kitne', 'kitni', 'hoga', 'hogi', 'liye', 'tak', 'par'],
  en: ['the', 'is', 'are', 'you', 'your', 'to', 'and', 'of', 'for', 'we', 'will', 'thank', 'thanks', 'please', 'our', 'it', 'on', 'at', 'a', 'an', 'be', 'can', 'with', 'open', 'from'],
  es: ['el', 'la', 'los', 'las', 'de', 'que', 'y', 'en', 'por', 'para', 'es', 'está', 'gracias', 'usted', 'su', 'hola', 'con', 'un', 'una', 'nuestro', 'le', 'lunes', 'abrimos', 'cuesta'],
  pt: ['o', 'os', 'as', 'de', 'que', 'e', 'em', 'para', 'é', 'está', 'obrigado', 'obrigada', 'você', 'vocês', 'seu', 'sua', 'olá', 'não', 'com', 'um', 'uma', 'nosso', 'nossa', 'custa', 'entrega'],
};

/** Heuristic language id for eval scoring: ur, ar, hi, roman-ur, en, es, pt. */
export function detectLanguage(text) {
  const arabic = (text.match(ARABIC_SCRIPT) ?? []).length;
  const deva = (text.match(DEVANAGARI) ?? []).length;
  const latin = (text.match(LATIN) ?? []).length;
  if (arabic > latin && arabic >= deva) return URDU_ONLY.test(text) ? 'ur' : 'ar';
  if (deva > latin) return 'hi';
  const words = text.toLowerCase().match(/[a-zà-ÿ]+/g) ?? [];
  let best = 'en';
  let bestScore = -1;
  for (const [lang, list] of Object.entries(STOP)) {
    const set = new Set(list);
    const score = words.filter((w) => set.has(w)).length;
    if (score > bestScore) {
      best = lang;
      bestScore = score;
    }
  }
  return best;
}

/** Every group must have at least one alternative present (case-insensitive). */
export function includesFacts(text, groups) {
  const t = text.toLowerCase();
  return groups.every((alts) => alts.some((a) => t.includes(String(a).toLowerCase())));
}

const normalise = (s) =>
  s
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

/** Word error rate (Levenshtein over words). */
export function wer(reference, hypothesis) {
  const r = normalise(reference);
  const h = normalise(hypothesis);
  if (r.length === 0) return h.length === 0 ? 0 : 1;
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) {
    for (let j = 1; j <= h.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
    }
  }
  return d[r.length][h.length] / r.length;
}

export function percentile(values, p) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

/**
 * Model switch rule (spec §8.1): the candidate must be equal or better on every quality metric
 * and within the latency budget. Returns a list of failures (empty = pass).
 */
export function compareToBaseline(candidate, baseline, { latencySlack = 1.1 } = {}) {
  const fails = [];
  const higherBetter = ['language_match', 'facts_adherence', 'json_validity', 'extraction_accuracy', 'safety_recall', 'voice_language_accuracy'];
  const lowerBetter = ['safety_false_positive_rate', 'wer'];
  for (const k of higherBetter) {
    if (baseline[k] != null && candidate[k] != null && candidate[k] + 1e-9 < baseline[k]) fails.push(`${k} ${candidate[k]} < ${baseline[k]}`);
  }
  for (const k of lowerBetter) {
    if (baseline[k] != null && candidate[k] != null && candidate[k] > baseline[k] + 1e-9) fails.push(`${k} ${candidate[k]} > ${baseline[k]}`);
  }
  for (const k of ['chat_p95_ms', 'safety_p95_ms']) {
    if (baseline[k] && candidate[k] && candidate[k] > baseline[k] * latencySlack) fails.push(`${k} ${candidate[k]} > ${Math.round(baseline[k] * latencySlack)}`);
  }
  return fails;
}
