import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KoneqtiAI, BusyError, GatewayError } from '../index.js';

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = responses.shift();
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status, headers: r.headers ?? {} });
  };
  fn.calls = calls;
  return fn;
}

test('chat sends Koneqti headers and parses JSON output', async () => {
  const f = fakeFetch([{ status: 200, body: { choices: [{ message: { content: '{"a":1}' } }] }, headers: { 'x-model-used': 'qwen3-4b' } }]);
  const ai = new KoneqtiAI({ url: 'http://gw', key: 'k', fetch: f });
  const out = await ai.chat('extract.order', { messages: [], response_format: { type: 'json_object' } }, { tenant: 't1', priority: 'interactive' });
  assert.deepEqual(out.json, { a: 1 });
  assert.equal(out.meta.modelUsed, 'qwen3-4b');
  const h = f.calls[0].init.headers;
  assert.equal(h.authorization, 'Bearer k');
  assert.equal(h['x-task'], 'extract.order');
  assert.equal(h['x-tenant-id'], 't1');
  assert.equal(h['x-priority'], 'interactive');
});

test('503 → BusyError with retryAfter (no retries by default)', async () => {
  const f = fakeFetch([{ status: 503, body: { error: { code: 'busy', message: 'busy' } }, headers: { 'retry-after': '3' } }]);
  const ai = new KoneqtiAI({ url: 'http://gw', key: 'k', fetch: f });
  await assert.rejects(ai.chat('reply', { messages: [] }, { tenant: 't' }), (e) => e instanceof BusyError && e.retryAfterSec === 3);
});

test('503 retried when busyRetries > 0', async () => {
  const f = fakeFetch([
    { status: 503, body: { error: { code: 'busy' } }, headers: { 'retry-after': '1' } },
    { status: 200, body: { choices: [{ message: { content: 'ok' } }] } },
  ]);
  const ai = new KoneqtiAI({ url: 'http://gw', key: 'k', fetch: f, busyRetries: 1 });
  assert.equal((await ai.chat('summary', { messages: [] }, { tenant: 't' })).text, 'ok');
});

test('422 surfaces the gateway error code', async () => {
  const f = fakeFetch([{ status: 422, body: { error: { code: 'tts_language_unavailable', message: 'no voice' } } }]);
  const ai = new KoneqtiAI({ url: 'http://gw', key: 'k', fetch: f });
  await assert.rejects(ai.speech('hi', { tenant: 't', language: 'xx' }), (e) => e instanceof GatewayError && e.code === 'tts_language_unavailable');
});

test('chatStream yields deltas', async () => {
  const sse =
    'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"Ji "}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"haan"}}]}\n\n' +
    'data: [DONE]\n\n';
  const f = fakeFetch([{ status: 200, body: sse, headers: { 'content-type': 'text/event-stream' } }]);
  const ai = new KoneqtiAI({ url: 'http://gw', key: 'k', fetch: f });
  let text = '';
  for await (const d of ai.chatStream('reply', { messages: [] }, { tenant: 't' })) text += d;
  assert.equal(text, 'Ji haan');
});
