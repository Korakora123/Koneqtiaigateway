import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { GatewayError } from '../errors.js';
import { resolveTask, withSlot, type ResolvedTask } from '../context.js';
import { cacheKey } from '../cache.js';
import { canonicalTag, guessLanguage, sameLanguage } from '../lang.js';
import { checkJsonOutput, prepareChat } from './chat.js';

const TranslateBody = z.object({
  texts: z.array(z.string()).min(1),
  from: z.string().min(2).max(16).default('auto'),
  to: z.string().min(2).max(16),
  context: z.enum(['chat', 'call']).default('chat'),
});

interface Cached {
  t: string; // translation
  f: string; // detected source language
  c: number; // confidence
}

/** BCP-47 tag → configured language (exact, else without region: `es-MX` → `es`). */
export function resolveLanguage(tag: string, languages: Record<string, string>): string | null {
  const c = canonicalTag(tag);
  if (c in languages) return c;
  const noRegion = c
    .split('-')
    .filter((p, i) => i === 0 || p.length === 4)
    .join('-');
  return noRegion in languages ? noRegion : null;
}

/**
 * Source-language decision from the model's answer and the cheap script/word guess.
 * Both agree → high confidence; only one has an opinion → medium; they disagree → low
 * (a script-based guess wins over the model, a word-based one doesn't).
 */
export function decideSource(
  modelLang: string | null,
  guess: { code: string | null; strength: number },
): { lang: string | null; confidence: number } {
  const r = (n: number): number => Math.round(n * 100) / 100;
  if (modelLang && guess.code && sameLanguage(modelLang, guess.code)) {
    return { lang: modelLang, confidence: r(Math.min(0.98, 0.85 + 0.15 * guess.strength)) };
  }
  if (modelLang && !guess.code) return { lang: modelLang, confidence: 0.75 };
  if (!modelLang && guess.code) return { lang: guess.code, confidence: r(0.5 + 0.3 * guess.strength) };
  if (modelLang && guess.code) {
    return guess.strength >= 0.9 ? { lang: guess.code, confidence: 0.6 } : { lang: modelLang, confidence: 0.55 };
  }
  return { lang: null, confidence: 0 };
}

/** Majority guess across the texts (weighted by strength). */
function batchGuess(texts: string[]): { code: string | null; strength: number } {
  const score = new Map<string, number>();
  for (const t of texts) {
    const g = guessLanguage(t);
    if (g.code) score.set(g.code, (score.get(g.code) ?? 0) + g.strength + 0.01);
  }
  let best: string | null = null;
  let total = 0;
  let top = 0;
  for (const [code, s] of score) {
    total += s;
    if (s > top) {
      top = s;
      best = code;
    }
  }
  return { code: best, strength: best ? Math.round((top / total) * Math.min(1, top / texts.length) * 100) / 100 : 0 };
}

function cacheAllowed(req: FastifyRequest, deps: Deps, task: ResolvedTask): 'use' | 'off' | '' {
  if (!task.cfg.cache_ttl_s) return '';
  if (String(req.headers['x-kq-cache'] ?? '').toLowerCase() === 'off') return 'off';
  if (!deps.usage.getSettings(req.ctx.product!, req.ctx.subtenant ?? 'system').allow_cache) return 'off';
  return 'use';
}

/**
 * POST /v1/translate (MesgAI handover §3, master §17.1)
 * `{texts[], from: "auto"|bcp47, to, context: "chat"|"call"}` → `{texts[], from_detected, confidence}`.
 * Local model only; per-business cache per text; nothing is logged but metadata.
 */
export function registerTranslate(app: FastifyInstance, deps: Deps): void {
  const cfg = deps.files.translate;
  const codes = Object.keys(cfg.languages);
  const model = deps.files.tasks.models;

  app.post('/v1/translate', async (req, reply) => {
    const body = TranslateBody.parse(req.body);
    const n = body.texts.length;
    if (n > cfg.limits.max_texts) throw new GatewayError(413, 'too_many_texts', `at most ${cfg.limits.max_texts} texts per request`);
    const chars = body.texts.reduce((a, t) => a + t.length, 0);
    if (chars > cfg.limits.max_total_chars) {
      throw new GatewayError(413, 'text_too_long', `texts are longer than ${cfg.limits.max_total_chars} characters in total`);
    }
    const to = resolveLanguage(body.to, cfg.languages);
    if (!to) throw new GatewayError(422, 'language_unsupported', `target language "${body.to}" is not supported`);
    const auto = body.from.toLowerCase() === 'auto';
    const from = auto ? null : resolveLanguage(body.from, cfg.languages);
    if (!auto && !from) throw new GatewayError(422, 'language_unsupported', `source language "${body.from}" is not supported`);

    const task = resolveTask(req, deps, { fixedTask: body.context === 'call' ? 'translate.call' : 'translate.chat', service: 'llm' });
    const ctx = req.ctx;
    ctx.chars = chars;
    const ollamaModel = model[task.cfg.model]?.ollama_model ?? task.cfg.model;

    // Same language in and out → nothing to do.
    if (from && sameLanguage(from, to)) {
      return reply.send({ texts: body.texts, from_detected: from, confidence: 1, model: task.cfg.model });
    }

    const mode = cacheAllowed(req, deps, task);
    const sub = ctx.subtenant ?? 'system';
    const keys = body.texts.map((text) => cacheKey({ v: 1, task: task.name, model: ollamaModel, from: from ?? 'auto', to, text }));
    const out: Array<Cached | null> = body.texts.map((text, i) => {
      if (!text.trim()) return { t: text, f: from ?? '', c: 1 }; // empty / whitespace: unchanged
      if (mode !== 'use') return null;
      const hit = deps.cache.get(ctx.product!, sub, keys[i]!);
      return hit ? (JSON.parse(hit.content) as Cached) : null;
    });
    const missIdx = out.flatMap((o, i) => (o ? [] : [i]));
    ctx.cache = mode === 'off' ? 'off' : mode === 'use' ? (missIdx.length ? 'miss' : 'hit') : '';

    if (missIdx.length) {
      const missTexts = missIdx.map((i) => body.texts[i]!);
      const fromClause = from ? `from ${cfg.languages[from]}` : 'from its source language (detect it)';
      const system = cfg.system_prompt
        .replace('{from_clause}', fromClause)
        .replace('{to_name}', `${cfg.languages[to]} [${to}]`)
        .replace('{context}', cfg.contexts[body.context])
        .replace('{codes}', codes.join(', '));
      const schema = {
        type: 'object',
        properties: {
          source_language: { type: 'string' },
          translations: { type: 'array', items: { type: 'string' }, minItems: missTexts.length, maxItems: missTexts.length },
        },
        required: ['source_language', 'translations'],
      };
      const missChars = missTexts.reduce((a, t) => a + t.length, 0);
      const prepared = prepareChat(
        {
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: JSON.stringify(missTexts) },
          ],
          stream: false,
          temperature: 0,
          max_tokens: Math.min(2048, Math.ceil(missChars * 0.9) + 40 * missTexts.length + 32),
          response_format: { type: 'json_schema', json_schema: { name: 'translation', schema } },
        },
        task,
        deps,
      );
      const res = await withSlot(req, deps, deps.pools.llm, task, (signal) => deps.ollama.chat(prepared.ollama, signal));
      ctx.tokensIn = res.tokensIn;
      ctx.tokensOut = res.tokensOut;
      ctx.evalMs = res.evalMs;
      ctx.promptMs = res.promptMs;
      if (res.doneReason === 'length') throw new GatewayError(502, 'invalid_model_output', 'translation was cut off');
      const parsed = checkJsonOutput(res.content, schema) as { source_language: string; translations: string[] };

      const modelLang = from ?? resolveLanguage(parsed.source_language, cfg.languages);
      const decided = from ? { lang: from, confidence: 1 } : decideSource(modelLang, batchGuess(missTexts));
      missIdx.forEach((i, k) => {
        const entry: Cached = { t: parsed.translations[k]!, f: decided.lang ?? '', c: decided.confidence };
        out[i] = entry;
        if (mode === 'use') {
          deps.cache.put(ctx.product!, sub, keys[i]!, task.name, { content: JSON.stringify(entry), tokensIn: 0, tokensOut: 0 }, task.cfg.cache_ttl_s);
        }
      });
    }

    // One answer for the batch: the language seen most, with the lowest confidence among its texts.
    const filled = out as Cached[];
    const votes = new Map<string, { n: number; c: number }>();
    for (const o of filled) {
      if (!o.f) continue;
      const v = votes.get(o.f) ?? { n: 0, c: 1 };
      votes.set(o.f, { n: v.n + 1, c: Math.min(v.c, o.c) });
    }
    const [fromDetected, vote] = [...votes.entries()].sort((a, b) => b[1].n - a[1].n)[0] ?? [from, { n: 0, c: from ? 1 : 0 }];
    return reply.send({
      texts: filled.map((o) => o.t),
      from_detected: fromDetected ?? null,
      confidence: vote.c,
      model: task.cfg.model,
    });
  });
}
