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

  it('400 when x-kq-subtenant is missing on work endpoints', async () => {
    h = await harness();
    const r = await h.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: authHeaders().authorization!, 'x-task': 'reply' },
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('subtenant_required');
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

    const rows = h.deps.usage.byTask('mesgai', 0, Date.now() + 1, 'biz-001');
    expect(rows).toEqual({ reply: expect.objectContaining({ calls: 1, tokens: 50, tokens_in: 30, tokens_out: 20 }) });
    expect(r.headers['x-kq-usage-tokens']).toBe('50');
    expect(r.headers['x-kq-model']).toBe('qwen3-4b');

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
    expect(h.deps.usage.byTask('mesgai', 0, Date.now() + 1).reply).toMatchObject({ tokens_out: 17 });
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
      headers: authHeaders('extract.order', { 'x-kq-cache': 'off' }), // identical request would be a cache hit
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
    expect(h.deps.usage.byTask('mesgai', 0, Date.now() + 1)['classify.intent']).toMatchObject({ busy: 1 });
  });

  it('full queue → 503 busy for the overflow, every other request answered', async () => {
    h = await harness({ OLLAMA_NUM_PARALLEL: '1' });
    // pools are built from config at startup — rebuild the llm pool with the small queue
    const { PriorityPool } = await import('../src/queue/pool.js');
    h.deps.pools.llm.close();
    h.deps.pools.llm = new PriorityPool({
      name: 'llm',
      slots: 1,
      maxQueue: { normal: 2, batch: 2 },
      initialServiceMs: 10,
      peakMaxBatch: 1,
      isOffPeak: () => false,
    });
    h.ollama.handler = ollamaReply('ok', { delayMs: 150 });
    const reqs = Array.from({ length: 5 }, (_, i) =>
      h.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders('reply', { 'x-kq-subtenant': `t${i}` }),
        payload: { messages: [{ role: 'user', content: 'x' }] },
      }),
    );
    const codes = (await Promise.all(reqs)).map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 200, 200, 503, 503]);
  });

  it('x-kq-priority overrides the task default; legacy X-Priority interactive = normal', async () => {
    h = await harness();
    const send = (task: string, extra: Record<string, string>) =>
      h.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders(task, extra), payload: { messages: [{ role: 'user', content: 'x' }] } });
    expect((await send('reply', { 'x-kq-priority': 'batch' })).statusCode).toBe(200);
    expect((await send('reply', { 'x-priority': 'interactive' })).statusCode).toBe(200);
    expect((await send('reply', { 'x-kq-priority': 'urgent' })).json().error.code).toBe('invalid_priority');
    expect(h.logs.text).toContain('"priority":"batch"');
    expect(h.logs.text).toContain('"priority":"normal"');
  });

  it('realtime turn gets 503 at once when no worker is free (never queued)', async () => {
    h = await harness();
    h.ollama.handler = ollamaReply('ok', { delayMs: 300 });
    const send = (sub: string, extra: Record<string, string> = {}) =>
      h.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders('reply', { 'x-kq-subtenant': sub, ...extra }),
        payload: { messages: [{ role: 'user', content: 'x' }] },
      });
    const busyOnes = [send('a'), send('b')]; // fill both llm slots
    await new Promise((r) => setTimeout(r, 30));
    const t0 = Date.now();
    const rt = await send('c', { 'x-kq-priority': 'realtime' });
    expect(rt.statusCode).toBe(503);
    expect(rt.headers['retry-after']).toBe('1');
    expect(Date.now() - t0).toBeLessThan(150);
    await Promise.all(busyOnes);
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

  it('per-business concurrency limit → 429 subtenant_limit, other businesses unaffected', async () => {
    h = await harness();
    h.ollama.handler = ollamaReply('ok', { delayMs: 200 });
    const one = () =>
      h.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders('reply'), payload: { messages: [{ role: 'user', content: 'x' }] } });
    const other = () =>
      h.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders('reply', { 'x-kq-subtenant': 'biz-002' }),
        payload: { messages: [{ role: 'user', content: 'x' }] },
      });
    const res = await Promise.all([one(), one(), one(), one(), one(), other()]);
    const limited = res.filter((r) => r.statusCode === 429);
    expect(limited.length).toBeGreaterThanOrEqual(1);
    expect(limited[0]!.json().error.code).toBe('subtenant_limit');
    expect(res.at(-1)!.statusCode).toBe(200);
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
    expect(r.json()).toEqual({
      text: 'SECRET-TRANSCRIPT',
      language: 'ur',
      language_probability: 0.93,
      confidence: 0.81,
      duration_sec: 4.2,
      duration: 4.2,
    });
    expect(r.headers['x-kq-usage-audio-sec']).toBe('4.20');
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
      expect(b).toMatchObject({ language: 'ur', voice: 'hi_IN-pratham-medium', format: 'ogg_opus' });
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
    expect(r.headers['x-kq-usage-audio-sec']).toBe('1.50');
  });

  it('TTS: BCP-47 tags, new format names, cloned/foreign voices, stream', async () => {
    h = await harness();
    const seen: Array<{ language: string; format: string }> = [];
    h.tts.handler = (req, body, res) => {
      if (req.url !== '/synthesize') return json(res, 200, { ok: true });
      seen.push(JSON.parse(body.toString()) as { language: string; format: string });
      res.writeHead(200, { 'content-type': 'audio/basic', 'x-audio-seconds': '1' }).end(Buffer.from([0xff]));
    };
    const say = (payload: Record<string, unknown>) => h.app.inject({ method: 'POST', url: '/v1/audio/speech', headers: authHeaders(), payload });
    expect((await say({ input: 'مرحبا', language: 'ar-EG', format: 'mulaw_8k' })).statusCode).toBe(200);
    expect(seen.at(-1)).toMatchObject({ language: 'ar', format: 'mulaw_8k' });
    expect((await say({ input: 'x', language: 'en', format: 'pcm_16k' })).statusCode).toBe(200);
    // Roman Urdu has no voice: never read by the Urdu-script voice → 422, product sends text
    expect((await say({ input: 'Aap ka order', language: 'ur-Latn' })).json().error.code).toBe('tts_language_unavailable');
    expect((await say({ input: 'x', language: 'en', voice: 'v_9a1c' })).statusCode).toBe(404);
    expect((await say({ input: 'x', language: 'en', stream: true })).statusCode).toBe(501);
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
    expect(u.json()).toMatchObject({ tenant: 'tokofy', by_task: {} });
  });
});

describe('tenant / subtenant contract (master §11.1, handover §0–1)', () => {
  it('tenant comes from the key: X-Tenant-Id must match it, else 403', async () => {
    h = await harness();
    const r = await h.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders('reply', { 'x-tenant-id': 'tokofy' }),
      payload: { messages: [{ role: 'user', content: 'x' }] },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('tenant_mismatch');
    const noHeader = { ...authHeaders('reply') };
    delete noHeader['x-tenant-id'];
    const ok = await h.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: noHeader, payload: { messages: [{ role: 'user', content: 'x' }] } });
    expect(ok.statusCode).toBe(200);
  });

  it("echoes the caller's X-Request-Id", async () => {
    h = await harness();
    const r = await h.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders('reply', { 'x-request-id': 'mesgai-msg-123' }),
      payload: { messages: [{ role: 'user', content: 'x' }] },
    });
    expect(r.headers['x-request-id']).toBe('mesgai-msg-123');
  });

  it('usage per subtenant with from/to; totals without subtenant; scoped to the key', async () => {
    h = await harness();
    const send = (sub: string) =>
      h.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders('reply', { 'x-kq-subtenant': sub }), payload: { messages: [{ role: 'user', content: 'x' }] } });
    await send('biz-a');
    await send('biz-a');
    await send('biz-b');
    const today = new Date().toISOString().slice(0, 10);
    const auth = { authorization: authHeaders().authorization! };
    const a = await h.app.inject({ method: 'GET', url: `/v1/usage?subtenant=biz-a&from=${today}&to=${today}`, headers: auth });
    expect(a.json()).toMatchObject({ tenant: 'mesgai', subtenant: 'biz-a', by_task: { reply: { calls: 2, tokens: 118 } } });
    const all = await h.app.inject({ method: 'GET', url: '/v1/usage', headers: auth });
    expect(all.json().by_task.reply.calls).toBe(3);
    const other = await h.app.inject({ method: 'GET', url: '/v1/usage?subtenant=biz-a', headers: { authorization: `Bearer ${KEY2}` } });
    expect(other.json().by_task).toEqual({});
  });

  it('subtenant settings and data delete', async () => {
    h = await harness();
    const auth = { authorization: authHeaders().authorization!, 'content-type': 'application/json' };
    await h.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: authHeaders('reply', { 'x-kq-subtenant': 'biz-z' }), payload: { messages: [{ role: 'user', content: 'x' }] } });
    const g0 = await h.app.inject({ method: 'GET', url: '/v1/subtenants/biz-z/settings', headers: auth });
    expect(g0.json()).toMatchObject({ retention_days: 0, allow_cache: true, known: true }); // auto-created on first use
    const put = await h.app.inject({ method: 'PUT', url: '/v1/subtenants/biz-z/settings', headers: auth, payload: { retention_days: 7, allow_cache: false } });
    expect(put.json()).toEqual({ ok: true });
    expect((await h.app.inject({ method: 'GET', url: '/v1/subtenants/biz-z/settings', headers: auth })).json()).toMatchObject({ retention_days: 7, allow_cache: false });
    expect((await h.app.inject({ method: 'PUT', url: '/v1/subtenants/biz-z/settings', headers: auth, payload: { retention_days: -1 } })).statusCode).toBe(400);
    // another tenant can't see or delete it
    const tok = { authorization: `Bearer ${KEY2}` };
    expect((await h.app.inject({ method: 'GET', url: '/v1/subtenants/biz-z/settings', headers: tok })).json().known).toBe(false);
    const del = await h.app.inject({ method: 'DELETE', url: '/v1/subtenants/biz-z/data', headers: { authorization: auth.authorization } });
    expect(del.json()).toMatchObject({ ok: true, removed: { usage_rows: 1 } });
    expect(h.deps.usage.byTask('mesgai', 0, Date.now() + 1, 'biz-z')).toEqual({});
    expect((await h.app.inject({ method: 'GET', url: '/v1/subtenants/biz-z/settings', headers: auth })).json().known).toBe(false);
  });

  it('safety text over 1000 chars → 413', async () => {
    h = await harness();
    const r = await h.app.inject({ method: 'POST', url: '/v1/safety/classify', headers: authHeaders(), payload: { text: 'a'.repeat(1001) } });
    expect(r.statusCode).toBe(413);
  });
});

describe('per-business answer cache (master §5)', () => {
  const classify = (sub: string, extra: Record<string, string> = {}) =>
    h.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders('classify.intent', { 'x-kq-subtenant': sub, ...extra }),
      payload: { messages: [{ role: 'user', content: 'order kab aayega? SECRET-CACHE-PROMPT' }] },
    });

  it('second identical request is a hit: no model call, 0 tokens, same answer', async () => {
    h = await harness();
    h.ollama.handler = ollamaReply('order_status');
    const a = await classify('biz-1');
    expect(a.headers['x-kq-cache']).toBe('miss');
    const calls = h.ollama.requests.length;
    const b = await classify('biz-1');
    expect(b.statusCode).toBe(200);
    expect(b.headers['x-kq-cache']).toBe('hit');
    expect(b.headers['x-kq-usage-tokens']).toBe('0');
    expect(b.json().choices[0].message.content).toBe('order_status');
    expect(h.ollama.requests.length).toBe(calls); // model not called
    expect(h.ollama.lastJson<{ options: { temperature: number } }>().options.temperature).toBe(0); // task default
    expect(h.deps.usage.byTask('mesgai', 0, Date.now() + 1, 'biz-1')['classify.intent']).toMatchObject({ calls: 2, cache_hits: 1 });
    // the prompt is never stored, only a hash
    const rows = h.deps.usage.db.prepare('SELECT * FROM cache_entries').all();
    expect(JSON.stringify(rows)).not.toContain('SECRET-CACHE-PROMPT');
  });

  it('never shared between businesses; off by header or by business setting; deleted with the business', async () => {
    h = await harness();
    h.ollama.handler = ollamaReply('x');
    await classify('biz-1');
    expect((await classify('biz-2')).headers['x-kq-cache']).toBe('miss');
    expect((await classify('biz-1', { 'x-kq-cache': 'off' })).headers['x-kq-cache']).toBe('off');
    h.deps.usage.putSettings('mesgai', 'biz-3', { retention_days: 0, allow_cache: false });
    await classify('biz-3');
    expect((await classify('biz-3')).headers['x-kq-cache']).toBe('off');
    const del = await h.app.inject({ method: 'DELETE', url: '/v1/subtenants/biz-1/data', headers: { authorization: authHeaders().authorization! } });
    expect(del.json().removed.cache_entries).toBe(1);
    expect((await classify('biz-1')).headers['x-kq-cache']).toBe('miss');
  });

  it('replies (temperature 0.4, no TTL) are never cached', async () => {
    h = await harness();
    const send = () =>
      h.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders('reply'),
        payload: { temperature: 0.4, messages: [{ role: 'user', content: 'x' }] },
      });
    await send();
    const r = await send();
    expect(r.headers['x-kq-cache']).toBeUndefined();
    expect(h.ollama.requests.filter((q) => q.url === '/api/chat').length).toBe(2);
  });
});

describe('POST /v1/translate (handover §3)', () => {
  const tr = (payload: Record<string, unknown>, extra: Record<string, string> = {}) =>
    h.app.inject({ method: 'POST', url: '/v1/translate', headers: authHeaders(undefined, extra), payload });
  const modelSays = (source: string, translations: string[]) => ollamaReply(JSON.stringify({ source_language: source, translations }));

  it('Roman Urdu → English with auto-detect; ur-Latn is first-class', async () => {
    h = await harness();
    h.ollama.handler = modelSays('ur-Latn', ['Can you deliver tomorrow?']);
    const r = await tr({ texts: ['Kya aap kal delivery kar sakte hain?'], from: 'auto', to: 'en', context: 'chat' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ texts: ['Can you deliver tomorrow?'], from_detected: 'ur-Latn', model: 'qwen3-4b' });
    expect(r.json().confidence).toBeGreaterThanOrEqual(0.85); // model and word-guess agree
    const sent = h.ollama.lastJson<{ messages: Array<{ content: string }>; options: { temperature: number } }>();
    expect(sent.messages[0]!.content).toContain('into English [en]');
    expect(sent.messages[0]!.content).toContain('WhatsApp');
    expect(sent.options.temperature).toBe(0);
    expect(h.logs.text).not.toContain('delivery kar');
    expect(h.logs.text).toContain('"task":"translate.chat"');
  });

  it('batch of texts, per-text cache: only new texts go to the model', async () => {
    h = await harness();
    h.ollama.handler = modelSays('es', ['Hello', 'Thanks']);
    const a = await tr({ texts: ['Hola', 'Gracias'], from: 'es', to: 'en' });
    expect(a.json().texts).toEqual(['Hello', 'Thanks']);
    expect(a.headers['x-kq-cache']).toBe('miss');
    h.ollama.handler = modelSays('es', ['Tomorrow']);
    const b = await tr({ texts: ['Hola', 'Mañana', 'Gracias'], from: 'es', to: 'en' });
    expect(b.json()).toMatchObject({ texts: ['Hello', 'Tomorrow', 'Thanks'], from_detected: 'es', confidence: 1 });
    expect(JSON.parse(h.ollama.lastJson<{ messages: Array<{ content: string }> }>().messages[1]!.content)).toEqual(['Mañana']);
    const calls = h.ollama.requests.length;
    const c = await tr({ texts: ['Gracias'], from: 'es', to: 'en' });
    expect(c.headers['x-kq-cache']).toBe('hit');
    expect(h.ollama.requests.length).toBe(calls);
    // another business never gets these
    expect((await tr({ texts: ['Gracias'], from: 'es', to: 'en' }, { 'x-kq-subtenant': 'biz-other' })).headers['x-kq-cache']).toBe('miss');
  });

  it('same language in and out → returned unchanged without a model call; region ignored', async () => {
    h = await harness();
    const r = await tr({ texts: ['مرحبا'], from: 'ar-EG', to: 'ar-SA' });
    expect(r.json()).toMatchObject({ texts: ['مرحبا'], confidence: 1 });
    expect(h.ollama.requests.filter((q) => q.url === '/api/chat')).toHaveLength(0);
    // but Urdu script → Roman Urdu is a real translation (different script)
    h.ollama.handler = modelSays('ur', ['aap ka order tayyar hai']);
    expect((await tr({ texts: ['آپ کا آرڈر تیار ہے'], from: 'ur', to: 'ur-Latn' })).json().texts).toEqual(['aap ka order tayyar hai']);
  });

  it('script evidence beats a wrong model guess (lower confidence)', async () => {
    h = await harness();
    h.ollama.handler = modelSays('hi', ['Your order is ready']);
    const r = await tr({ texts: ['آپ کا آرڈر تیار ہے'], to: 'en' });
    expect(r.json()).toMatchObject({ from_detected: 'ur', confidence: 0.6 });
  });

  it('validation: unsupported language 422, too many / too long 413, wrong count from model 502', async () => {
    h = await harness();
    expect((await tr({ texts: ['x'], to: 'xx' })).json().error.code).toBe('language_unsupported');
    expect((await tr({ texts: ['x'], from: 'zz', to: 'en' })).statusCode).toBe(422);
    expect((await tr({ texts: Array(21).fill('x'), to: 'en' })).json().error.code).toBe('too_many_texts');
    expect((await tr({ texts: ['a'.repeat(4001)], to: 'en' })).statusCode).toBe(413);
    h.ollama.handler = modelSays('es', ['only one']);
    expect((await tr({ texts: ['uno', 'dos'], from: 'es', to: 'en' })).statusCode).toBe(502);
  });

  it('context "call" runs as realtime: 503 at once when no worker is free', async () => {
    h = await harness();
    h.ollama.handler = ollamaReply('ok', { delayMs: 300 });
    const fill = [0, 1].map((i) =>
      h.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders('reply', { 'x-kq-subtenant': `f${i}` }),
        payload: { messages: [{ role: 'user', content: 'x' }] },
      }),
    );
    await new Promise((r) => setTimeout(r, 30));
    const r = await tr({ texts: ['Kal aa jayenge'], to: 'en', context: 'call' });
    expect(r.statusCode).toBe(503);
    await Promise.all(fill);
  });
});
