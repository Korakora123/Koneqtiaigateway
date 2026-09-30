// @koneqti/ai — thin client for koneqti-ai-gateway. No dependencies (Node 20+ fetch).
// Prompts, facts and safety decisions stay in the product; this only transports them.

export class GatewayError extends Error {
  constructor(status, code, message, { retryAfterSec, requestId } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.code = code;
    this.retryAfterSec = retryAfterSec;
    this.requestId = requestId;
  }
}

/** 503 busy: the gateway could not meet the timeout. Send your holding reply / keyword fallback. */
export class BusyError extends GatewayError {
  constructor(message, opts) {
    super(503, 'busy', message, opts);
    this.name = 'BusyError';
  }
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason);
    }, { once: true });
  });

function meta(res) {
  return {
    requestId: res.headers.get('x-request-id'),
    modelUsed: res.headers.get('x-model-used'),
    queueMs: Number(res.headers.get('x-queue-ms') ?? 0),
    usage: res.headers.get('x-usage'),
  };
}

export class KoneqtiAI {
  /**
   * @param {{url?: string, key?: string, busyRetries?: number, maxRetryWaitMs?: number, fetch?: typeof fetch}} [o]
   * Defaults read AI_GATEWAY_URL / AI_GATEWAY_KEY.
   */
  constructor(o = {}) {
    this.url = (o.url ?? process.env.AI_GATEWAY_URL ?? '').replace(/\/$/, '');
    this.key = o.key ?? process.env.AI_GATEWAY_KEY;
    if (!this.url || !this.key) throw new Error('AI_GATEWAY_URL and AI_GATEWAY_KEY are required');
    this.busyRetries = o.busyRetries ?? 0; // realtime callers usually want 0: fall back immediately
    this.maxRetryWaitMs = o.maxRetryWaitMs ?? 10_000;
    this.fetch = o.fetch ?? globalThis.fetch;
  }

  headers({ tenant, task, priority, maxLatencyMs } = {}, json = true) {
    if (!tenant) throw new Error('tenant is required (X-Tenant-Id)');
    return {
      authorization: `Bearer ${this.key}`,
      'x-tenant-id': String(tenant),
      ...(task ? { 'x-task': task } : {}),
      ...(priority ? { 'x-priority': priority } : {}),
      ...(maxLatencyMs ? { 'x-max-latency-ms': String(maxLatencyMs) } : {}),
      ...(json ? { 'content-type': 'application/json' } : {}),
    };
  }

  async request(path, init, opts = {}) {
    let attempt = 0;
    for (;;) {
      const res = await this.fetch(`${this.url}${path}`, { ...init, signal: opts.signal });
      if (res.ok) return res;
      let body = {};
      try {
        body = await res.json();
      } catch {
        /* non-JSON error */
      }
      const retryAfterSec = Number(res.headers.get('retry-after') ?? 0) || undefined;
      const requestId = res.headers.get('x-request-id') ?? undefined;
      const code = body?.error?.code ?? 'error';
      const message = body?.error?.message ?? `gateway error ${res.status}`;
      if (res.status === 503) {
        const waitMs = (retryAfterSec ?? 1) * 1000;
        if (attempt < (opts.busyRetries ?? this.busyRetries) && waitMs <= this.maxRetryWaitMs) {
          attempt++;
          await sleep(waitMs, opts.signal);
          continue;
        }
        throw new BusyError(message, { retryAfterSec, requestId });
      }
      throw new GatewayError(res.status, code, message, { retryAfterSec, requestId });
    }
  }

  /** OpenAI-style chat completion. Returns {text, json?, response, meta}. */
  async chat(task, body, opts) {
    const res = await this.request(
      '/v1/chat/completions',
      { method: 'POST', headers: this.headers({ ...opts, task }), body: JSON.stringify({ ...body, stream: false }) },
      opts,
    );
    const response = await res.json();
    const text = response.choices?.[0]?.message?.content ?? '';
    const out = { text, response, meta: meta(res) };
    if (body.response_format && body.response_format.type !== 'text') out.json = JSON.parse(text);
    return out;
  }

  /** Streaming chat: async iterator of text deltas. */
  async *chatStream(task, body, opts) {
    const res = await this.request(
      '/v1/chat/completions',
      { method: 'POST', headers: this.headers({ ...opts, task }), body: JSON.stringify({ ...body, stream: true }) },
      opts,
    );
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const event = buf.slice(0, i).trim();
        buf = buf.slice(i + 2);
        if (!event.startsWith('data:')) continue;
        const data = event.slice(5).trim();
        if (data === '[DONE]') return;
        const j = JSON.parse(data);
        if (j.error) throw j.error.code === 'busy' ? new BusyError(j.error.message) : new GatewayError(502, j.error.code, j.error.message);
        const delta = j.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      }
    }
  }

  /** {category, score}. On BusyError, fall back to your keyword filter. */
  async classifySafety(text, opts) {
    const res = await this.request(
      '/v1/safety/classify',
      { method: 'POST', headers: this.headers(opts), body: JSON.stringify({ text, ...(opts.language ? { language: opts.language } : {}) }) },
      opts,
    );
    return { ...(await res.json()), meta: meta(res) };
  }

  /** Voice note → {text, language, confidence, duration}. `audio` is a Buffer/Uint8Array/Blob. */
  async transcribe(audio, opts) {
    const form = new FormData();
    form.append('file', audio instanceof Blob ? audio : new Blob([audio]), opts.filename ?? 'audio.ogg');
    if (opts.language) form.append('language', opts.language);
    const res = await this.request('/v1/audio/transcriptions', { method: 'POST', headers: this.headers(opts, false), body: form }, opts);
    return { ...(await res.json()), meta: meta(res) };
  }

  /** Text → audio Buffer. Throws GatewayError code tts_language_unavailable (422) → send text instead. */
  async speech(text, opts) {
    const res = await this.request(
      '/v1/audio/speech',
      {
        method: 'POST',
        headers: this.headers(opts),
        body: JSON.stringify({ input: text, language: opts.language, response_format: opts.format ?? 'ogg' }),
      },
      opts,
    );
    return { audio: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type'), meta: meta(res) };
  }
}
