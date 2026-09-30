import { GatewayError } from '../errors.js';

export interface TranscriptionResult {
  text: string;
  language: string;
  language_probability: number;
  confidence: number;
  duration: number;
  segments?: Array<{ start: number; end: number; text: string; avg_logprob: number; no_speech_prob: number }>;
}

async function call(url: string, init: RequestInit, signal: AbortSignal, what: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new GatewayError(502, 'backend_unavailable', `${what} service unreachable`);
  }
  if (res.ok) return res;
  let code = 'backend_error';
  let message = `${what} service error (${res.status})`;
  try {
    const body = (await res.json()) as { detail?: { code?: string; message?: string } | string };
    if (typeof body.detail === 'object' && body.detail?.code) {
      code = body.detail.code;
      message = body.detail.message ?? message;
    }
  } catch {
    /* not JSON */
  }
  const status = res.status === 503 ? 503 : res.status >= 400 && res.status < 500 ? res.status : 502;
  throw new GatewayError(status, status === 503 ? 'busy' : code, message, status === 503 ? 5 : undefined);
}

export class SpeechClient {
  constructor(private readonly baseUrl: string) {}

  async transcribe(
    audio: { data: Buffer; filename: string; mime: string },
    opts: { language?: string; prompt?: string; timestamps: boolean },
    signal: AbortSignal,
  ): Promise<TranscriptionResult> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio.data)], { type: audio.mime }), audio.filename);
    if (opts.language) form.append('language', opts.language);
    if (opts.prompt) form.append('prompt', opts.prompt);
    form.append('segments', String(opts.timestamps));
    const res = await call(`${this.baseUrl}/transcribe`, { method: 'POST', body: form }, signal, 'speech');
    return (await res.json()) as TranscriptionResult;
  }

  async ping(signal: AbortSignal): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/health`, { signal });
    return res.ok;
  }
}

export interface SynthesisResult {
  audio: Buffer;
  contentType: string;
  seconds: number;
  voice: string;
}

export class TtsClient {
  constructor(private readonly baseUrl: string) {}

  async synthesize(
    req: { text: string; language: string; voice?: string; format: string; speed?: number },
    signal: AbortSignal,
  ): Promise<SynthesisResult> {
    const res = await call(
      `${this.baseUrl}/synthesize`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) },
      signal,
      'tts',
    );
    return {
      audio: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
      seconds: Number(res.headers.get('x-audio-seconds') ?? 0),
      voice: res.headers.get('x-voice') ?? req.voice ?? '',
    };
  }

  async ping(signal: AbortSignal): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/health`, { signal });
    return res.ok;
  }
}
