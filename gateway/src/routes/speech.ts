import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { GatewayError } from '../errors.js';
import { resolveTask, withSlot } from '../context.js';

/** Output formats (handover §2.1). `ogg`/`opus` are v0 names for `ogg_opus`. */
export const TTS_FORMATS = ['ogg_opus', 'mp3', 'mulaw_8k', 'pcm_16k', 'wav', 'ogg', 'opus'] as const;
const FORMAT_ALIAS: Record<string, string> = { ogg: 'ogg_opus', opus: 'ogg_opus' };

const SpeechBody = z
  .object({
    model: z.string().optional(),
    input: z.string().optional(),
    text: z.string().optional(),
    language: z.string().min(2).max(16),
    voice: z.string().max(64).optional(),
    format: z.enum(TTS_FORMATS).optional(),
    response_format: z.enum(TTS_FORMATS).optional(),
    speed: z.number().min(0.5).max(2).optional(),
    stream: z.boolean().optional(),
  })
  .refine((b) => (b.input ?? b.text ?? '').trim().length > 0, { message: 'input (or text) is required' });

/**
 * BCP-47 → configured TTS language. Region is dropped (`ar-EG` → `ar`); a script subtag is kept,
 * so `ur-Latn` (Roman Urdu) never silently falls back to an Urdu-script voice.
 */
export function ttsLanguageKey(tag: string, available: Record<string, unknown>): string | null {
  const t = tag.trim().toLowerCase().replace(/_/g, '-');
  if (t in available) return t;
  const parts = t.split('-');
  const withoutRegion = parts.filter((p, i) => i === 0 || p.length === 4).join('-');
  return withoutRegion in available ? withoutRegion : null;
}

export function registerSpeech(app: FastifyInstance, deps: Deps): void {
  app.post('/v1/audio/speech', async (req, reply) => {
    const body = SpeechBody.parse(req.body);
    const text = (body.input ?? body.text ?? '').trim();
    if (body.stream) {
      throw new GatewayError(501, 'stream_not_available_yet', 'streaming speech arrives with live calls (handover Part 4)');
    }
    const key = ttsLanguageKey(body.language, deps.files.tts.languages);
    const lang = key ? deps.files.tts.languages[key] : undefined;
    if (!key || !lang || !lang.enabled) {
      throw new GatewayError(422, 'tts_language_unavailable', `no text-to-speech voice for language "${body.language}" in this stage`);
    }
    const language = key;
    if (body.voice?.startsWith('v_')) {
      // Cloned business voices (handover §2.2) are not built yet; none can exist.
      throw new GatewayError(404, 'voice_not_found', 'voice not found for this business');
    }
    if (body.voice && body.voice !== lang.voice) {
      throw new GatewayError(422, 'tts_voice_unavailable', `voice "${body.voice}" is not a stock voice for "${language}"`);
    }
    const maxChars = deps.files.limits.request.max_tts_chars;
    if (text.length > maxChars) throw new GatewayError(413, 'text_too_long', `text is longer than ${maxChars} characters`);

    const task = resolveTask(req, deps, { defaultTask: 'tts', service: 'tts' });
    req.ctx.chars = text.length;
    const requested = body.format ?? body.response_format ?? 'wav';
    const format = FORMAT_ALIAS[requested] ?? requested;
    const out = await withSlot(req, deps, deps.pools.tts, task, (signal) =>
      deps.tts.synthesize({ text, language, voice: lang.voice, format, ...(body.speed ? { speed: body.speed } : {}) }, signal),
    );
    req.ctx.audioSeconds = out.seconds;
    return reply.type(out.contentType).header('x-voice', out.voice).send(out.audio);
  });
}
