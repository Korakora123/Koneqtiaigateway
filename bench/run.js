#!/usr/bin/env node
// Benchmark: eval rate → capacity estimate (spec §5), optional load test + site spot-check.
// Records results in STATUS.md (acceptance 10). No dependencies; Node 20+.
//
//   AI_GATEWAY_KEY=... node bench/run.js                 # eval rate (5 replies) → STATUS.md
//   AI_GATEWAY_KEY=... node bench/run.js --load 6 --duration 120 \
//       --sites "https://site1 https://site2 https://site3"   # load test + CloudPanel spot-check
//   options: --url http://127.0.0.1:8787  --runs 5  --no-write
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? true) : def;
};
const URL_ = opt('url', process.env.AI_GATEWAY_URL ?? 'http://127.0.0.1:8787');
const KEY = process.env.AI_GATEWAY_KEY;
const RUNS = Number(opt('runs', 5));
const LOAD = Number(opt('load', 0));
const DURATION = Number(opt('duration', 120));
const SITES = String(opt('sites', process.env.SITE_URLS ?? '')).split(/\s+/).filter(Boolean);
const WRITE = !args.includes('--no-write');
const STATUS = join(dirname(fileURLToPath(import.meta.url)), '..', 'STATUS.md');

if (!KEY) {
  console.error('Set AI_GATEWAY_KEY (a product key; e.g. create a "bench" product with gen-key).');
  process.exit(1);
}

// Anonymised Roman Urdu customer messages (same style as the spec's benchmark prompt).
const PROMPTS = [
  'Assalam o alaikum, mera AC theek se thanda nahi kar raha, kal subah koi technician aa sakta hai? Kitne paise lagenge?',
  'Bhai 2 kilo chicken karahi ka order dena hai, ghar tak delivery kitni der mein ho jayegi?',
  'Mujhe apni appointment Jumeraat se Hafte par shift karni hai, kya 4 baje ka time mil jayega?',
  'Aap ki shop kab tak khuli hai aaj? Aur kya card se payment ho sakti hai?',
  'Pichle hafte jo order kiya tha woh abhi tak nahi mila, please check kar ke batayein.',
];
const SYSTEM =
  'You are a polite WhatsApp assistant for a small business in Pakistan. Reply in the same language and style as the customer (Roman Urdu if they write Roman Urdu). Keep replies short (2-3 sentences). Facts: open 10am-9pm, delivery 45 minutes, card and cash accepted, technician visit fee Rs 1500.';

async function reply(prompt, tenant = 'bench') {
  const t0 = performance.now();
  const res = await fetch(`${URL_}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${KEY}`,
      'content-type': 'application/json',
      'x-tenant-id': tenant,
      'x-task': 'reply',
    },
    body: JSON.stringify({ messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }], max_tokens: 150 }),
  });
  const ms = performance.now() - t0;
  const usage = Object.fromEntries(
    (res.headers.get('x-usage') ?? '')
      .split(';')
      .filter((p) => p.includes('='))
      .map((p) => p.split('=')),
  );
  if (res.ok) await res.json();
  else await res.text();
  return {
    status: res.status,
    ms,
    queueMs: Number(res.headers.get('x-queue-ms') ?? 0),
    model: res.headers.get('x-model-used'),
    tokensOut: Number(usage.tokens_out ?? 0),
    evalMs: Number(usage.eval_ms ?? 0),
  };
}

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const r1 = (n) => Math.round(n * 10) / 10;

async function siteProbe(url) {
  const t0 = performance.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    await r.arrayBuffer();
    return { ok: r.ok, ms: performance.now() - t0 };
  } catch {
    return { ok: false, ms: performance.now() - t0 };
  }
}

async function sitesSnapshot(label) {
  const out = {};
  for (const s of SITES) {
    const rs = [];
    for (let i = 0; i < 3; i++) rs.push(await siteProbe(s));
    out[s] = { avgMs: Math.round(rs.reduce((a, b) => a + b.ms, 0) / rs.length), failures: rs.filter((x) => !x.ok).length };
  }
  if (SITES.length) console.log(`sites (${label}):`, out);
  return out;
}

async function evalRate() {
  console.log(`warm-up (loads the model if needed)…`);
  const warm = await reply(PROMPTS[0]);
  if (warm.status !== 200) throw new Error(`gateway answered ${warm.status} — check key, /health and that the model is pulled`);
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    const r = await reply(PROMPTS[i % PROMPTS.length]);
    if (r.status !== 200) throw new Error(`run ${i + 1}: status ${r.status}`);
    runs.push(r);
    console.log(`  run ${i + 1}: ${Math.round(r.ms)} ms, ${r.tokensOut} tokens, ${r1((r.tokensOut / r.evalMs) * 1000)} tok/s`);
  }
  const rate = runs.reduce((a, r) => a + r.tokensOut, 0) / (runs.reduce((a, r) => a + r.evalMs, 0) / 1000);
  // spec §5: replies/min ≈ (eval_rate × 2 × 0.7) ÷ 150 × 60   (2 parallel slots, 70% efficiency, 150-token reply)
  const perMin = ((rate * 2 * 0.7) / 150) * 60;
  const perHour = perMin * 60;
  // ~50 customer messages/day per business, ~12 of them in the busiest hour → businesses ≈ replies/hour ÷ 12
  const businesses = perHour / 12;
  return {
    model: runs[0].model,
    evalRate: r1(rate),
    avgReplyMs: Math.round(runs.reduce((a, r) => a + r.ms, 0) / runs.length),
    avgTokens: Math.round(runs.reduce((a, r) => a + r.tokensOut, 0) / runs.length),
    perMin: r1(perMin),
    perHour: Math.round(perHour),
    businesses: Math.round(businesses),
  };
}

async function loadTest() {
  console.log(`load test: ${LOAD} concurrent clients for ${DURATION}s…`);
  const until = Date.now() + DURATION * 1000;
  const results = [];
  const siteDuring = [];
  const siteLoop = (async () => {
    while (SITES.length && Date.now() < until) {
      for (const s of SITES) siteDuring.push({ s, ...(await siteProbe(s)) });
      await new Promise((r) => setTimeout(r, 2000));
    }
  })();
  await Promise.all(
    Array.from({ length: LOAD }, async (_, c) => {
      let i = c;
      while (Date.now() < until) {
        const r = await reply(PROMPTS[i++ % PROMPTS.length], `bench-${c}`).catch(() => ({ status: 0, ms: 0 }));
        results.push(r);
        if (r.status === 503) await new Promise((res) => setTimeout(res, 1000));
      }
    }),
  );
  await siteLoop;
  const ok = results.filter((r) => r.status === 200);
  const lat = ok.map((r) => r.ms);
  const sites = {};
  for (const s of SITES) {
    const xs = siteDuring.filter((x) => x.s === s);
    sites[s] = { avgMs: Math.round(xs.reduce((a, b) => a + b.ms, 0) / (xs.length || 1)), maxMs: Math.round(Math.max(0, ...xs.map((x) => x.ms))), failures: xs.filter((x) => !x.ok).length };
  }
  return {
    clients: LOAD,
    durationS: DURATION,
    requests: results.length,
    ok: ok.length,
    busy503: results.filter((r) => r.status === 503).length,
    errors: results.filter((r) => r.status !== 200 && r.status !== 503).length,
    repliesPerMin: r1((ok.length / DURATION) * 60),
    p50Ms: Math.round(pct(lat, 50)),
    p95Ms: Math.round(pct(lat, 95)),
    p95QueueMs: Math.round(pct(ok.map((r) => r.queueMs), 95)),
    sites,
  };
}

function writeStatus(ev, load, sitesIdle) {
  const date = new Date().toISOString().replace('T', ' ').slice(0, 16);
  let block = `Last run: ${date} UTC — model \`${ev.model}\`\n\n`;
  block += `| eval rate | avg reply | avg tokens | est. replies/min | est. replies/hour | est. active businesses |\n|---|---|---|---|---|---|\n`;
  block += `| ${ev.evalRate} tok/s | ${(ev.avgReplyMs / 1000).toFixed(1)} s | ${ev.avgTokens} | ${ev.perMin} | ${ev.perHour} | ~${ev.businesses} |\n`;
  if (load) {
    block += `\nLoad test: ${load.clients} clients × ${load.durationS}s → ${load.ok}/${load.requests} ok, ${load.busy503} × 503 busy, ${load.errors} errors, `;
    block += `${load.repliesPerMin} replies/min, p50 ${(load.p50Ms / 1000).toFixed(1)} s, **p95 ${(load.p95Ms / 1000).toFixed(1)} s** (alert > 20 s), p95 queue ${(load.p95QueueMs / 1000).toFixed(1)} s\n`;
    for (const [s, v] of Object.entries(load.sites)) {
      const idle = sitesIdle[s];
      block += `- site ${s}: idle ${idle?.avgMs ?? '?'} ms → under AI load avg ${v.avgMs} ms / max ${v.maxMs} ms, failures ${v.failures}\n`;
    }
  }
  const row = `| ${date} | ${ev.model} | ${ev.evalRate} | ${ev.perMin} | ~${ev.businesses} | ${load ? `${(load.p95Ms / 1000).toFixed(1)} s` : '—'} |`;
  let md = existsSync(STATUS) ? readFileSync(STATUS, 'utf8') : '# STATUS\n';
  const start = '<!-- BENCH:START -->';
  const end = '<!-- BENCH:END -->';
  if (md.includes(start) && md.includes(end)) {
    md = md.slice(0, md.indexOf(start) + start.length) + '\n' + block + md.slice(md.indexOf(end));
  } else {
    md += `\n## Benchmarks\n${start}\n${block}${end}\n`;
  }
  // history table: marker line, header, separator, then rows (newest first)
  const lines = md.split('\n');
  const h = lines.findIndex((l) => l.startsWith('<!-- BENCH:HISTORY'));
  if (h >= 0) {
    lines.splice(h + 3, 0, row);
    md = lines.join('\n');
  }
  writeFileSync(STATUS, md);
  console.log(`STATUS.md updated`);
}

const sitesIdle = await sitesSnapshot('idle');
const ev = await evalRate();
console.log('eval-rate result:', ev);
const load = LOAD > 0 ? await loadTest() : null;
if (load) console.log('load result:', load);
if (WRITE) writeStatus(ev, load, sitesIdle);
