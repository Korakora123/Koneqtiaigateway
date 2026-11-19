#!/usr/bin/env node
// Benchmark: eval rate → capacity estimate (spec §5), optional load test + site spot-check.
// Records results in STATUS.md (acceptance 10). No dependencies; Node 20+.
//
//   AI_GATEWAY_KEY=... node bench/run.js                 # eval rate (5 replies) → STATUS.md
//   AI_GATEWAY_KEY=... node bench/run.js --load 6 --duration 120 \
//       --sites "https://site1 https://site2 https://site3"   # load test + CloudPanel spot-check
//   options: --url http://127.0.0.1:8787  --runs 5  --no-write  --quick (skip the realistic ~900-token runs)
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

// Realistic MesgAI request (handover §1.1: ≤ 900 tokens = business facts + 3-sentence summary
// + last 5 messages). Fixed part first, changing part last, so the engine can reuse the start.
const FACT_LINES = [
  'Services: AC repair, AC installation, gas refilling, fridge repair, washing machine repair, geyser service.',
  'Prices: AC general service Rs 2500, gas refill Rs 6500 (1.5 ton), installation Rs 4000, visit fee Rs 1500 (waived if work is done).',
  'Area: Lahore only — DHA, Gulberg, Model Town, Johar Town, Bahria Town, Cantt. Outside these areas: say we will check and call back.',
  'Timings: Monday to Saturday 9am to 8pm, Sunday closed. Emergency visits after 8pm cost Rs 1000 extra.',
  'Booking: ask for name, area, full address, appliance, problem, preferred time. Confirm the time slot before saying booked.',
  'Payment: cash, JazzCash, EasyPaisa, bank transfer. Warranty: 30 days on service, 90 days on parts.',
  'Never promise a time that is not free. Never give medical, legal or financial advice. If the customer is angry, apologise once and offer a call from the owner.',
];
function mesgaiMessages(business, userMsg) {
  const facts = FACT_LINES.map((l, i) => `${i + 1}. ${l}`).join('\n');
  const system =
    `You are the WhatsApp assistant of ${business}. Reply in the customer's language and script ` +
    `(Roman Urdu if they write Roman Urdu). 1-3 short sentences. Use only these facts; if something is not here, say you will check.\n` +
    `Business facts:\n${facts}\n${facts.replace(/Rs (\d+)/g, 'PKR $1')}\n` +
    `Conversation summary: Customer asked about AC service last week, got the price list, has not booked yet. Lives in Johar Town. Prefers evening slots.`;
  const history = [
    { role: 'user', content: 'Assalam o alaikum, AC service ka kya rate hai?' },
    { role: 'assistant', content: 'Wa alaikum assalam! AC general service Rs 2500 hai, visit fee kaam hone par maaf hai.' },
    { role: 'user', content: 'Gas bhi kam lag rahi hai, refill kitne ka hoga?' },
    { role: 'assistant', content: '1.5 ton AC ki gas refill Rs 6500 hai. Kya main booking kar doon?' },
  ];
  return [{ role: 'system', content: system }, ...history, { role: 'user', content: userMsg }];
}

async function reply(prompt, tenant = 'bench', messages = null) {
  const t0 = performance.now();
  const res = await fetch(`${URL_}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${KEY}`,
      'content-type': 'application/json',
      'x-kq-subtenant': tenant,
      'x-task': 'reply',
    },
    body: JSON.stringify({ messages: messages ?? [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }], max_tokens: 150, temperature: 0.4 }),
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
    tokensIn: Number(usage.tokens_in ?? 0),
    tokensOut: Number(usage.tokens_out ?? 0),
    evalMs: Number(usage.eval_ms ?? 0),
    promptMs: Number(usage.prompt_ms ?? 0),
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

function summarise(runs) {
  const sum = (k) => runs.reduce((a, r) => a + r[k], 0);
  const n = runs.length;
  return {
    promptTokens: Math.round(sum('tokensIn') / n),
    prefillRate: r1(sum('tokensIn') / (sum('promptMs') / 1000 || 1)),
    prefillS: r1(sum('promptMs') / n / 1000),
    genRate: r1(sum('tokensOut') / (sum('evalMs') / 1000 || 1)),
    genS: r1(sum('evalMs') / n / 1000),
    // wall time; never less than the engine's own prompt + reply time
    totalS: r1(Math.max(sum('ms'), sum('promptMs') + sum('evalMs')) / n / 1000),
  };
}

/**
 * Realistic MesgAI replies (~900-token context). "new" = a different business every time
 * (nothing reusable); "returning" = same business, new last message (start of prompt reusable).
 * Shows whether reading the prompt (prefill) or writing the reply dominates — GATEWAY_AUDIT §8.
 */
async function realistic() {
  console.log('realistic MesgAI prompts (~900 tokens)…');
  const cold = [];
  for (let i = 0; i < RUNS; i++) {
    const r = await reply(null, `bench-new-${i}`, mesgaiMessages(`Business ${Date.now() % 100000}-${i} Cooling Services`, PROMPTS[i % PROMPTS.length]));
    if (r.status !== 200) throw new Error(`realistic run ${i + 1}: status ${r.status}`);
    cold.push(r);
    console.log(`  new business ${i + 1}: ${Math.round(r.ms)} ms (prompt ${r.tokensIn} tok in ${r.promptMs} ms, reply ${r.tokensOut} tok in ${r.evalMs} ms)`);
  }
  const biz = `Returning Business ${Date.now() % 100000} AC Care`;
  await reply(null, 'bench-returning', mesgaiMessages(biz, PROMPTS[0])); // prime the engine's prompt cache
  const warm = [];
  for (let i = 0; i < RUNS; i++) {
    const r = await reply(null, 'bench-returning', mesgaiMessages(biz, PROMPTS[(i + 1) % PROMPTS.length]));
    if (r.status !== 200) throw new Error(`returning run ${i + 1}: status ${r.status}`);
    warm.push(r);
    console.log(`  returning business ${i + 1}: ${Math.round(r.ms)} ms (prompt ${r.tokensIn} tok in ${r.promptMs} ms)`);
  }
  const c = summarise(cold);
  const w = summarise(warm);
  // 2 parallel slots; ~50 messages/day per business, ~12 in the busiest hour
  const perMin = (s) => r1((2 * 60) / (s || 1));
  return {
    cold: c,
    warm: w,
    perMinCold: perMin(c.totalS),
    perMinWarm: perMin(w.totalS),
    businessesCold: Math.round((perMin(c.totalS) * 60) / 12),
    businessesWarm: Math.round((perMin(w.totalS) * 60) / 12),
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

function writeStatus(ev, real, load, sitesIdle) {
  const date = new Date().toISOString().replace('T', ' ').slice(0, 16);
  let block = `Last run: ${date} UTC — model \`${ev.model}\`\n\n`;
  block += `| eval rate | avg reply | avg tokens | est. replies/min | est. replies/hour | est. active businesses |\n|---|---|---|---|---|---|\n`;
  block += `| ${ev.evalRate} tok/s | ${(ev.avgReplyMs / 1000).toFixed(1)} s | ${ev.avgTokens} | ${ev.perMin} | ${ev.perHour} | ~${ev.businesses} |\n`;
  if (real) {
    const row = (name, x, pm, b) =>
      `| ${name} | ${x.promptTokens} | ${x.prefillRate} tok/s · ${x.prefillS} s | ${x.genRate} tok/s · ${x.genS} s | **${x.totalS} s** | ${pm} | ~${b} |\n`;
    block += `\nRealistic MesgAI reply (~900-token context, max 150 tokens):\n\n`;
    block += `| case | prompt tokens read | prompt reading | reply writing | total | replies/min (2 slots) | est. businesses |\n|---|---|---|---|---|---|---|\n`;
    block += row('new business (nothing reusable)', real.cold, real.perMinCold, real.businessesCold);
    block += row('returning business (prompt start reused)', real.warm, real.perMinWarm, real.businessesWarm);
    const slow = real.cold.prefillS > real.cold.genS ? 'prompt reading' : 'reply writing';
    block += `\nSlowest part for a new business: **${slow}**. Reply budget is 25 s.\n`;
  }
  if (load) {
    block += `\nLoad test: ${load.clients} clients × ${load.durationS}s → ${load.ok}/${load.requests} ok, ${load.busy503} × 503 busy, ${load.errors} errors, `;
    block += `${load.repliesPerMin} replies/min, p50 ${(load.p50Ms / 1000).toFixed(1)} s, **p95 ${(load.p95Ms / 1000).toFixed(1)} s** (alert > 20 s), p95 queue ${(load.p95QueueMs / 1000).toFixed(1)} s\n`;
    for (const [s, v] of Object.entries(load.sites)) {
      const idle = sitesIdle[s];
      block += `- site ${s}: idle ${idle?.avgMs ?? '?'} ms → under AI load avg ${v.avgMs} ms / max ${v.maxMs} ms, failures ${v.failures}\n`;
    }
  }
  const row = `| ${date} | ${ev.model} | ${ev.evalRate} | ${ev.perMin} | ~${ev.businesses} | ${real ? `${real.cold.totalS} s / ${real.warm.totalS} s` : '—'} | ${load ? `${(load.p95Ms / 1000).toFixed(1)} s` : '—'} |`;
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
const real = args.includes('--quick') ? null : await realistic();
if (real) console.log('realistic result:', real);
const load = LOAD > 0 ? await loadTest() : null;
if (load) console.log('load result:', load);
if (WRITE) writeStatus(ev, real, load, sitesIdle);
