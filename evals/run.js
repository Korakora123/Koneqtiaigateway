#!/usr/bin/env node
// Runs the eval sets through the gateway (spec §8.1) and writes results/<date>.json.
//   AI_GATEWAY_KEY=... npm --prefix evals run eval
//   AI_GATEWAY_KEY=... npm --prefix evals run eval -- --baseline results/2026-10-01T0100.json
// Options: --url http://127.0.0.1:8787  --only chat,extract,safety,voice  --safety-threshold 0.5
// A model switch is allowed only if every metric is equal or better and latency is within budget.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectLanguage, includesFacts, wer, percentile, compareToBaseline } from './lib.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const URL_ = opt('url', process.env.AI_GATEWAY_URL ?? 'http://127.0.0.1:8787');
const KEY = process.env.AI_GATEWAY_KEY;
const ONLY = new Set(String(opt('only', 'chat,extract,safety,voice')).split(','));
const THRESH = Number(opt('safety-threshold', 0.5));
const BASELINE = opt('baseline');
if (!KEY) {
  console.error('Set AI_GATEWAY_KEY');
  process.exit(1);
}

const readJsonl = (f) =>
  existsSync(f)
    ? readFileSync(f, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l))
    : [];
const headers = (task) => ({
  authorization: `Bearer ${KEY}`,
  'content-type': 'application/json',
  'x-tenant-id': 'evals',
  ...(task ? { 'x-task': task } : {}),
});

async function post(path, body, task) {
  const t0 = performance.now();
  const res = await fetch(`${URL_}${path}`, { method: 'POST', headers: headers(task), body: JSON.stringify(body) });
  const ms = performance.now() - t0;
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  return { status: res.status, ms, data, model: res.headers.get('x-model-used') };
}

const rate = (xs) => (xs.length ? Math.round((xs.filter(Boolean).length / xs.length) * 1000) / 1000 : null);
const out = { date: new Date().toISOString(), url: URL_, model: null, metrics: {}, by_language: {}, failures: [] };

if (ONLY.has('chat')) {
  const items = readJsonl(join(HERE, 'data/chat.jsonl'));
  const lat = [];
  const lm = [];
  const fa = [];
  for (const it of items) {
    const r = await post('/v1/chat/completions', { messages: it.messages, max_tokens: 200 }, 'reply');
    if (r.status !== 200) {
      out.failures.push({ id: it.id, status: r.status });
      lm.push(false);
      fa.push(false);
      continue;
    }
    out.model ??= r.model;
    const text = r.data.choices[0].message.content;
    const lang = detectLanguage(text);
    const langOk = lang === it.language;
    const factsOk = includesFacts(text, it.must_include_any);
    lat.push(r.ms);
    lm.push(langOk);
    fa.push(factsOk);
    const b = (out.by_language[it.language] ??= { n: 0, language_match: 0, facts: 0 });
    b.n++;
    b.language_match += langOk ? 1 : 0;
    b.facts += factsOk ? 1 : 0;
    // ids + detected language only: eval outputs are not stored (anonymised sets, but keep the habit)
    if (!langOk || !factsOk) out.failures.push({ id: it.id, detected_language: lang, language_ok: langOk, facts_ok: factsOk });
    process.stdout.write(langOk && factsOk ? '.' : 'x');
  }
  console.log(' chat');
  out.metrics.language_match = rate(lm);
  out.metrics.facts_adherence = rate(fa);
  out.metrics.chat_p50_ms = Math.round(percentile(lat, 50));
  out.metrics.chat_p95_ms = Math.round(percentile(lat, 95));
}

if (ONLY.has('extract')) {
  const items = readJsonl(join(HERE, 'data/extract.jsonl'));
  const valid = [];
  const acc = [];
  for (const it of items) {
    const r = await post(
      '/v1/chat/completions',
      { messages: it.messages, response_format: { type: 'json_schema', json_schema: { name: 'x', schema: it.schema } } },
      it.task,
    );
    const ok = r.status === 200;
    valid.push(ok);
    let correct = false;
    if (ok) {
      const j = JSON.parse(r.data.choices[0].message.content);
      const list = j.items ?? j.lines ?? [];
      const expCount = it.expect.items_count ?? it.expect.lines_count;
      const qty = list.map((x) => Number(x.quantity));
      correct = list.length === expCount && it.expect.quantities.every((q, i) => qty[i] === q);
    }
    acc.push(correct);
    if (!ok || !correct) out.failures.push({ id: it.id, status: r.status, schema_valid: ok, fields_correct: correct });
    process.stdout.write(ok && correct ? '.' : 'x');
  }
  console.log(' extract');
  out.metrics.json_validity = rate(valid);
  out.metrics.extraction_accuracy = rate(acc);
}

if (ONLY.has('safety')) {
  const items = readJsonl(join(HERE, 'data/safety.jsonl'));
  const lat = [];
  const hits = [];
  const fps = [];
  let busy = 0;
  for (const it of items) {
    const r = await post('/v1/safety/classify', { text: it.text });
    if (r.status === 503) busy++;
    if (r.status !== 200) {
      if (it.expected !== 'none') hits.push(false);
      out.failures.push({ id: it.id, status: r.status });
      continue;
    }
    lat.push(r.ms);
    const flagged = r.data.category !== 'none' && r.data.score >= THRESH;
    if (it.expected === 'none') fps.push(flagged);
    else hits.push(flagged && r.data.category === it.expected);
    const good = it.expected === 'none' ? !flagged : flagged && r.data.category === it.expected;
    if (!good) out.failures.push({ id: it.id, expected: it.expected, got: r.data.category, score: r.data.score });
    process.stdout.write(good ? '.' : 'x');
  }
  console.log(' safety');
  out.metrics.safety_recall = rate(hits);
  out.metrics.safety_false_positive_rate = rate(fps);
  out.metrics.safety_p95_ms = Math.round(percentile(lat, 95));
  out.metrics.safety_busy_503 = busy;
}

if (ONLY.has('voice')) {
  const dir = join(HERE, 'data/voice');
  const items = readJsonl(join(dir, 'manifest.jsonl'));
  const wers = [];
  const langOk = [];
  for (const it of items) {
    const path = join(dir, it.file);
    if (!existsSync(path)) continue;
    const form = new FormData();
    form.append('file', new Blob([readFileSync(path)]), it.file);
    const res = await fetch(`${URL_}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'x-tenant-id': 'evals' },
      body: form,
    });
    if (!res.ok) {
      out.failures.push({ id: it.id, status: res.status });
      continue;
    }
    const j = await res.json();
    wers.push(wer(it.reference, j.text));
    langOk.push(j.language === it.language);
    process.stdout.write('.');
  }
  if (items.length) console.log(' voice');
  out.metrics.wer = wers.length ? Math.round((wers.reduce((a, b) => a + b, 0) / wers.length) * 1000) / 1000 : null;
  out.metrics.voice_language_accuracy = rate(langOk);
}

console.log(JSON.stringify(out.metrics, null, 2));
const file = join(HERE, 'results', `${out.date.slice(0, 16).replace(/:/g, '')}-${(out.model ?? 'model').replace(/[^\w.-]/g, '_')}.json`);
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`results → ${file}`);

if (BASELINE) {
  const base = JSON.parse(readFileSync(BASELINE, 'utf8')).metrics;
  const fails = compareToBaseline(out.metrics, base);
  if (fails.length) {
    console.log('MODEL SWITCH NOT ALLOWED:\n - ' + fails.join('\n - '));
    process.exit(2);
  }
  console.log('PASS: equal or better than baseline and within latency budget');
}
