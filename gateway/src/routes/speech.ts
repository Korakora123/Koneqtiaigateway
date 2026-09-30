import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { GatewayError } from '../errors.js';
import { resolveTask, withSlot } from '../context.js';

export const TTS_FORMATS = ['wav', 'mp3', 'ogg', 'opus'] as const;

const SpeechBody = z
  .object({
    model: z.string().optional(),
    input: z.string().optional(),
    text: z.string().optional(),
    language: z.string().min(2).max(8),
    voice: z.string().max(64).optional(),
    format: z.enum(TTS_FORMATS).optional(),
    response_format: z.enum(TTS_FORMATS).optional(),
    speed: z.number().min(0.5).max(2).optional(),
  })
  .refine((b) => (b.input ?? b.text ?? '').trim().length > 0, { message: 'input (or text) is required' });

export function registerSpeech(app: FastifyInstance, deps: Deps): void {
  app.post('/v1/audio/speech', async (req, reply) => {
    const body = SpeechBody.parse(req.body);
    const text = (body.input ?? body.text ?? '').trim();
    const language = body.language.toLowerCase();

    const lang = deps.files.tts.languages[language];
    if (!lang || !lang.enabled) {
      throw new GatewayError(422, 'tts_language_unavailable', `no text-to-speech voice for language "${language}" in this stage`);
    }
    if (body.voice && body.voice !== lang.voice) {
      throw new GatewayError(422, 'tts_voice_unavailable', `voice "${body.voice}" is not configured for "${language}"`);
    }
    const maxChars = deps.files.limits.request.max_tts_chars;
    if (text.length > maxChars) throw new GatewayError(413, 'text_too_long', `text is longer than ${maxChars} characters`);

    const task = resolveTask(req, deps, { defaultTask: 'tts', service: 'tts' });
    req.ctx.chars = text.length;
    const format = body.response_format ?? body.format ?? 'wav';
    const out = await withSlot(req, deps, deps.pools.tts, task, (signal) =>
      deps.tts.synthesize({ text, language, voice: lang.voice, format, ...(body.speed ? { speed: body.speed } : {}) }, signal),
    );
    req.ctx.audioSeconds = out.seconds;
    return reply.type(out.contentType).header('x-voice', out.voice).send(out.audio);
  });
}
