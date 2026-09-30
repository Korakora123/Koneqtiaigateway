import type { FastifyInstance } from 'fastify';
import type { Deps } from '../deps.js';
import { GatewayError } from '../errors.js';
import { resolveTask, withSlot } from '../context.js';

const LANG_RE = /^[a-z]{2,3}$/;

export function registerTranscriptions(app: FastifyInstance, deps: Deps): void {
  app.post('/v1/audio/transcriptions', async (req, reply) => {
    if (!req.isMultipart()) throw new GatewayError(400, 'multipart_required', 'send multipart/form-data with a `file` field');

    let audio: { data: Buffer; filename: string; mime: string } | null = null;
    const fields: Record<string, string> = {};
    for await (const part of req.parts({ limits: { fileSize: deps.files.limits.request.max_audio_bytes, files: 1 } })) {
      if (part.type === 'file') {
        if (part.fieldname !== 'file') {
          part.file.resume();
          continue;
        }
        const data = await part.toBuffer();
        if (part.file.truncated) throw new GatewayError(413, 'audio_too_large', 'audio file too large');
        audio = { data, filename: part.filename || 'audio', mime: part.mimetype || 'application/octet-stream' };
      } else if (typeof part.value === 'string') {
        fields[part.fieldname] = part.value;
      }
    }
    if (!audio || audio.data.length === 0) throw new GatewayError(400, 'file_required', '`file` is required');

    const language = fields.language?.toLowerCase();
    if (language !== undefined && !LANG_RE.test(language)) throw new GatewayError(400, 'invalid_language', 'language must be an ISO-639-1 code');
    const format = fields.response_format ?? 'json';
    if (!['json', 'text', 'verbose_json'].includes(format)) {
      throw new GatewayError(400, 'unsupported_response_format', 'response_format must be json, text or verbose_json');
    }

    const task = resolveTask(req, deps, { defaultTask: 'transcribe', service: 'speech' });
    const result = await withSlot(req, deps, deps.pools.speech, task, (signal) =>
      deps.speech.transcribe(
        audio,
        { ...(language ? { language } : {}), ...(fields.prompt ? { prompt: fields.prompt } : {}), timestamps: format === 'verbose_json' },
        signal,
      ),
    );
    req.ctx.audioSeconds = result.duration;

    if (format === 'text') return reply.type('text/plain; charset=utf-8').send(result.text);
    const base = {
      text: result.text,
      language: result.language,
      language_probability: result.language_probability,
      confidence: result.confidence,
      duration: result.duration,
    };
    return reply.send(format === 'verbose_json' ? { task: 'transcribe', ...base, segments: result.segments ?? [] } : base);
  });
}
