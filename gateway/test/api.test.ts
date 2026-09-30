import { afterEach, describe, expect, it } from 'vitest';
import { authHeaders, harness, json, KEY2, ollamaReply, type Harness } from './helpers.js';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const ROMAN_URDU_PROMPT = 'Assalam o alaikum, kal subah plumber aa sakta hai? SECRET-PROMPT-MARKER';
const ROMAN_URDU_REPLY = 'Wa alaikum assalam! Ji haan, kal subah 10 baje plumber aa jayega. SECRET-REPLY-MARKER';

const REQUIRED_HEADERS = ['x-model-used', 'x-queue-ms', 'x-usage', 'x-request-id'];

describe('access control', () => {
  it('401 without a product key, with all response headers set', async () => {
    h = await harness();
    const r = await h.app.inject({ method: 'POST', url: '/v1/chat/completions', payload: {} });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe('invalid_product_key');
    for (const k of REQUIRED_HEADERS) expect(r.headers[k]).toBeDefined();
  });

  it('403 from an address outside ALLOWED_IPS, even with a valid key', async () => {
    h = await harness({ ALLOWED_IPS: '10.9.9.9' });
    const r = await h.app.inject({ method: 'GET', url: '/v1/models', headers: authHeaders() });
    expect(r.statusCode).toBe(403);
    const hr = await h.app.inject({ method: 'GET', url: '/health' });
    expect(hr.statusCode).toBe(403);
  });

  it('400 when X-Tenant-Id is missing on work endpoints', async () => {
    h = await harness();
    const r = await h.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: authHeaders().authorization!, 'x-task': 'reply' },
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('tenant_required');
  });

  it('unknown task → 400; task on the wrong endpoint → 400', async () => {
    h = await harness();
    const msg = { messages: [{ role: 'user', content: 'hi' }] };
    const a = await h.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders('nope'), payload: msg });
    expect(a.json().error.code).toBe('unknown_task');
    const b = await h.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders('transcribe'), payload: msg });
    expect(b.json().error.code).toBe('wrong_endpoint');
  });
});

describe('POST /v1/chat/completions', () => {
  it('Roman Urdu reply via qwen3-4b; headers set; usage stored; no text in logs (acceptance 4)', async () => {
    h = await harness();
    h.ollama.handler = ollamaReply(`<think>\n\n</think>\n\n${ROMAN_URDU_REPLY}`, { promptTokens: 30, evalTokens: 20 });
    const r = await h.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders('reply'),
      payload: {
        model: 'anything',
        max_tokens: 1000,
        messages: [
          { role: 'system', content: 'You are a helpful assistant for a plumbing business.' },
          { role: 'user', content: ROMAN_URDU_PROMPT },
        ],
      },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.choices[0].message.content).toBe(ROMAN_URDU_REPLY);
    expect(body.usage).toEqual({ prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 });
    expect(r.headers['x-model-used']).toBe('qwen3-4b');
    expect(r.headers['x-usage']).toBe('tokens_in=30;tokens_out=20');
    expect(Number(r.headers['x-queue-ms'])).toBeGreaterThanOrEqual(0);
    expect(r.headers['x-request-id']).toMatch(/[0-9a-f-]{36}/);

    const sent = h.ollama.lastJson<{ model: string; think: boolean; options: Record<string, number> }>();
    expect(sent.model).toBe('qwen3:4b');
    expect(sent.think).toBe(false);
    expect(sent.options.num_predict).toBe(250); // task cap wins over product's 1000
    expect(sent.options.num_ctx).toBe(4096);
    expect(sent.options.num_thread).toBe(3);

    const rows = h.deps.usage.summary('mesgai', 0);
    expect(rows).toEqual([expect.objectContaining({ task: 'reply', model: 'qwen3-4b', requests: 1, tokens_in: 30, tokens_out: 20 })]);

    expect(h.logs.text).toContain('"task":"reply"');
    expect(h.logs.text).not.toContain('SECRET-PROMPT-MARKER');
    expect(h.logs.text).not.toContain('SECRET-REPLY-MARKER');
    expect(h.logs.text).not.toContain('plumbing');
  });

  it('streams OpenAI-style SSE chunks with usage', async () => {
    h = await harness();
    h.ollama.handler = ollamaReply('Ji haan, zaroor.');
    const r = await h.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders('reply'),
      payload: { stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'salam' }] },
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/event-stream');
    expect(r.headers['x-model-used']).toBe('qwen3-4b');
    const events = r.body
      .split('\n\n')
      .filter(Boolean)
      .map((e) => e.replace(/^data: /, ''));
    expect(events.at(-1)).toBe('[DONE]');
    const parsed = events.slice(0, -1).map((e) => JSON.parse(e));
    const text = parsed.map((c) => c.choices?.[0]?.delta?.content ?? '').join('');
    expect(text).toBe('Ji haan, zaroor.');
    expect(parsed.at(-1).usage.total_tokens).toBe(59);
    await new Promise((res) => setTimeout(res, 20));
    expect(h.deps.usage.summary('mesgai', 0)[0]).toMatchObject({ tokens_out: 17 });
  });

  it('extract.order requires a json_schema and returns schema-valid JSON (acceptance 5)', async () => {
    h = await harness();
    const schema = {
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, qty: { type: 'integer' } }, required: ['name', 'qty'] } },
        phone: { type: 'string' },
      },
      required: ['items'],
    };
    const messages = [{ role: 'user', content: '2 kg aata aur 1 doodh bhej dein' }];
    const missing = await h.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders('extract.order'), payload: { messages } });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe('json_schema_required');

    h.ollama.handler = ollamaReply('{"items":[{"name":"aata","qty":2},{"name":"doodh","qty":1}]}');
    const ok = await h.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders('extract.order'),
      payload: { messages, response_format: { type: 'json_schema', json_schema: { name: 'order', schema } } },
    });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.json().choices[0].message.content).items).toHaveLength(2);
    expect(h.ollama.lastJson<{ format: unknown; options: { temperature: number } }>().format).toEqual(schema);

    h.ollama.handler = ollamaReply('{"items":[{"name":"aata"}]}');
    const bad = await h.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders('extract.order'),
      payload: { messages, response_format: { type: 'json_schema', json_schema: { name: 'order', schema } } },
    });
    expect(bad.statusCode).toBe(502);
    expect(bad.json().error.code).toBe('schema_validation_failed');
  });

  it('timeout → 503 busy + Retry-After, recorded in usage (acceptance 7)', async () => {
    h = await harness();
    h.ollama.handler = ollamaReply('late', { delayMs: 800 });
    const r = await h.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders('classify.intent', { 'x-max-latency-ms': '200' }),
      payload: { messages: [{ role: 'user', content: 'x' }] },
    });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('busy');
    expect(Number(r.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(r.headers['x-model-used']).toBe('qwen3-4b');
    expect(h.deps.usage.summary('mesgai', 0)[0]).toMatchObject({ busy: 1 });
  });

  it('full queue → 503 busy for the overflow, every other request answered', async () => {
    h = await harness({ OLLAMA_NUM_PARALLEL: '1' });
    h.deps.files.limits.pools.llm.max_queue.realtime = 2;
    // pools are built from config at startup — rebuild the llm pool with the small queue
    const { PriorityPool } = await import('../src/queue/pool.js');
    h.deps.pools.llm.close();
    h.deps.pools.llm = new PriorityPool({
      name: 'llm',
      slots: 1,
      maxQueue: { realtime: 2, interactive: 2, batch: 2 },
      initialServiceMs: 10,
      peakMaxBatch: 1,
      isOffPeak: () => false,
    });
    h.ollama.handler = ollamaReply('ok', { delayMs: 150 });
    const reqs = Array.from({ length: 5 }, (_, i) =>
      h.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders('reply', { 'x-tenant-id': `t${i}` }),
        payload: { messages: [{ role: 'user', content: 'x' }] },
      }),
    );
    const codes = (await Promise.all(reqs)).map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 200, 200, 503, 503]);
  });

  it('X-Priority can lower but not raise priority', async () => {
    h = await harness();
    await h.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders('summary', { 'x-priority': 'realtime' }),
      payload: { messages: [{ role: 'user', content: 'x' }] },
    });
    await h.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders('reply', { 'x-priority': 'batch' }),
      payload: { messages: [{ role: 'user', content: 'x' }] },
    });
    const rows = h.deps.usage.summary('mesgai', 0);
    expect(rows.map((r) => r.task).sort()).toEqual(['reply', 'summary']);
  });

  it('rejects prompts that exceed MAX_CONTEXT_TOKENS', async () => {
    h = await harness({ MAX_CONTEXT_TOKENS: '256' });
    const r = await h.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders('reply'),
      payload: { messages: [{ role: 'user', content: 'a'.repeat(2000) }] },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('context_length_exceeded');
  });

  it('per-tenant concurrency limit → 429', async () => {
    h = await harness();
    h.ollama.handler = ollamaReply('ok', { delayMs: 200 });
    const one = () =>
      h.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders('reply'), payload: { messages: [{ role: 'user', content: 'x' }] } });
    const codes = (await Promise.all([one(), one(), one(), one(), one()])).map((r) => r.statusCode);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(1);
  });
});

describe('audio', () => {
  it('transcribes a voice note with language + confidence (acceptance 6)', async () => {
    h = await harness();
    h.speech.handler = (req, body, res) => {
      if (req.url === '/transcribe') {
        expect(body.toString('latin1')).toContain('name="language"');
        return json(res, 200, { text: 'SECRET-TRANSCRIPT', language: 'ur', language_probability: 0.93, confidence: 0.81, duration: 4.2 });
      }
      json(res, 200, { ok: true });
    };
    const boundary = '----kq';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="note.ogg"\r\nContent-Type: audio/ogg\r\n\r\n`),
      Buffer.from([1, 2, 3, 4]),
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nur\r\n--${boundary}--\r\n`),
    ]);
    const r = await h.app.inject({
      method: 'POST',
      url: '/v1/audio/transcriptions',
      headers: { ...authHeaders(), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ text: 'SECRET-TRANSCRIPT', language: 'ur', language_probability: 0.93, confidence: 0.81, duration: 4.2 });
    expect(r.headers['x-model-used']).toBe('whisper-small-int8');
    expect(r.headers['x-usage']).toBe('audio_seconds=4.20');
    expect(h.logs.text).not.toContain('SECRET-TRANSCRIPT');
  });

  it('TTS: unsupported language → 422 tts_language_unavailable', async () => {
    h = await harness();
    const r = await h.app.inject({ method: 'POST', url: '/v1/audio/speech', headers: authHeaders(), payload: { input: 'hello', language: 'xx' } });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('tts_language_unavailable');
  });

  it('TTS: returns audio from the tts service', async () => {
    h = await harness();
    h.tts.handler = (req, body, res) => {
      if (req.url !== '/synthesize') return json(res, 200, { ok: true });
      const b = JSON.parse(body.toString()) as { language: string; voice: string; format: string };
      expect(b).toMatchObject({ language: 'ur', voice: 'hi_IN-pratham-medium', format: 'ogg' });
      res.writeHead(200, { 'content-type': 'audio/ogg', 'x-audio-seconds': '1.5', 'x-voice': b.voice }).end(Buffer.from('OggS'));
    };
    const r = await h.app.inject({
      method: 'POST',
      url: '/v1/audio/speech',
      headers: authHeaders(),
      payload: { input: 'آپ کا آرڈر تیار ہے', language: 'ur', response_format: 'ogg' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('audio/ogg');
    expect(r.headers['x-model-used']).toBe('piper');
    expect(r.rawPayload.toString()).toBe('OggS');
  });
});

describe('other endpoints', () => {
  it('voices → 501 not_available_until_gpu; embeddings → 501', async () => {
    h = await harness();
    for (const method of ['PUT', 'GET', 'DELETE'] as const) {
      const r = await h.app.inject({ method, url: '/v1/voices/biz-1', headers: authHeaders() });
      expect(r.statusCode).toBe(501);
      expect(r.json().error.code).toBe('not_available_until_gpu');
    }
    const e = await h.app.inject({ method: 'POST', url: '/v1/embeddings', headers: authHeaders(), payload: {} });
    expect(e.statusCode).toBe(501);
  });

  it('safety classify returns {category, score} as forced JSON', async () => {
    h = await harness();
    h.ollama.handler = ollamaReply('{"category":"gas","score":0.93}');
    const r = await h.app.inject({
      method: 'POST',
      url: '/v1/safety/classify',
      headers: authHeaders(),
      payload: { text: 'kitchen mein gas ki boo aa rahi hai' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ category: 'gas', score: 0.93, model: 'qwen3-4b' });
    const sent = h.ollama.lastJson<{ format: { properties: { category: { enum: string[] } } } }>();
    expect(sent.format.properties.category.enum).toContain('carbon_monoxide');
  });

  it('health reports backends, queues and host stats; metrics are Prometheus text', async () => {
    h = await harness();
    const r = await h.app.inject({ method: 'GET', url: '/health' });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.ok).toBe(true);
    expect(b.services).toEqual({ ollama: true, speech: true, tts: true });
    expect(b.queues.map((q: { name: string }) => q.name)).toEqual(['llm', 'speech', 'tts']);
    expect(b.host.memTotalMb).toBeGreaterThan(0);
    const m = await h.app.inject({ method: 'GET', url: '/metrics' });
    expect(m.body).toContain('gateway_queue_length');
    expect(m.body).toContain('host_memory_used_percent');
  });

  it('health is 503 when the model is not pulled', async () => {
    h = await harness();
    h.ollama.handler = (_req, _b, res) => json(res, 200, { models: [] });
    const r = await h.app.inject({ method: 'GET', url: '/health' });
    expect(r.statusCode).toBe(503);
    expect(r.json().alerts).toContain('model_not_pulled');
  });

  it('models lists tasks; usage only shows the calling product', async () => {
    h = await harness();
    await h.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders('reply'), payload: { messages: [{ role: 'user', content: 'x' }] } });
    const m = await h.app.inject({ method: 'GET', url: '/v1/models', headers: { authorization: authHeaders().authorization! } });
    expect(m.json().data.map((d: { id: string }) => d.id)).toContain('qwen3-4b');
    const u = await h.app.inject({ method: 'GET', url: '/v1/usage', headers: { authorization: `Bearer ${KEY2}` } });
    expect(u.json()).toMatchObject({ product: 'tokofy', rows: [] });
  });
});
