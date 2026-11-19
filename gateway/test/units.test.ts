import { describe, expect, it } from 'vitest';
import { PriorityPool, type Lease } from '../src/queue/pool.js';
import { isOffPeak } from '../src/queue/offpeak.js';
import { IpAllowList, KeyStore, bearerToken, sha256Hex } from '../src/auth.js';
import { RateLimiter } from '../src/ratelimit.js';
import { GatewayError } from '../src/errors.js';
import { ThinkFilter, stripThink } from '../src/backends/ollama.js';
import { loadFileConfig } from '../src/config/files.js';
import { loadEnv } from '../src/config/env.js';
import { CONFIG_DIR } from './helpers.js';

const far = (): number => Date.now() + 60_000;

function mkPool(o: Partial<ConstructorParameters<typeof PriorityPool>[0]> = {}): PriorityPool {
  return new PriorityPool({
    name: 'llm',
    slots: 2,
    maxQueue: { normal: 4, batch: 4 },
    initialServiceMs: 100,
    peakMaxBatch: 1,
    isOffPeak: () => false,
    ...o,
  });
}

describe('PriorityPool', () => {
  it('serves fast normal, then normal (FIFO), then batch', async () => {
    const pool = mkPool({ slots: 1, isOffPeak: () => true });
    const first = await pool.acquire({ priority: 'normal', deadline: far() });
    const order: string[] = [];
    const take = (name: string, priority: 'normal' | 'batch', fast = false): Promise<void> =>
      pool.acquire({ priority, deadline: far(), fast }).then((l) => {
        order.push(name);
        l.release();
      });
    const all = Promise.all([take('b1', 'batch'), take('n1', 'normal'), take('f1', 'normal', true), take('n2', 'normal'), take('f2', 'normal', true)]);
    first.release();
    await all;
    expect(order).toEqual(['f1', 'f2', 'n1', 'n2', 'b1']);
    pool.close();
  });

  it('realtime never queues: reserved slot, else a free general slot, else 503 at once', async () => {
    const pool = mkPool({ slots: 1, reservedRealtime: 1 });
    const n = await pool.acquire({ priority: 'normal', deadline: far() }); // general slot busy
    const r1 = await pool.acquire({ priority: 'realtime', deadline: far() }); // reserved
    const t0 = Date.now();
    const err = await pool.acquire({ priority: 'realtime', deadline: far() }).catch((e: GatewayError) => e);
    expect(Date.now() - t0).toBeLessThan(50);
    expect((err as GatewayError).status).toBe(503);
    expect((err as GatewayError).retryAfterSec).toBe(1);
    // normal can never take the reserved slot
    r1.release();
    let started = false;
    const n2 = pool.acquire({ priority: 'normal', deadline: far() }).then((l) => {
      started = true;
      return l;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toBe(false);
    n.release();
    (await n2).release();
    // with the general slot free, realtime takes it even without a reservation
    const p0 = mkPool({ slots: 1, reservedRealtime: 0 });
    (await p0.acquire({ priority: 'realtime', deadline: far() })).release();
    pool.close();
    p0.close();
  });

  it('holds batch at peak while normal is waiting, and caps batch concurrency', async () => {
    const pool = mkPool({ slots: 2, isOffPeak: () => false, peakMaxBatch: 1 });
    const b1 = await pool.acquire({ priority: 'batch', deadline: far() });
    let b2Started = false;
    const b2 = pool.acquire({ priority: 'batch', deadline: far() }).then((l) => {
      b2Started = true;
      return l;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(b2Started).toBe(false); // one slot free, but peak cap = 1 batch
    const n1 = await pool.acquire({ priority: 'normal', deadline: far() });
    expect(pool.stats().running.normal).toBe(1);
    b1.release();
    await new Promise((r) => setTimeout(r, 20));
    expect(b2Started).toBe(true);
    (await b2).release();
    n1.release();
    pool.close();
  });

  it('runs batch on every slot inside the off-peak window', async () => {
    const pool = mkPool({ slots: 2, isOffPeak: () => true, peakMaxBatch: 1 });
    const a = await pool.acquire({ priority: 'batch', deadline: far() });
    const b = await pool.acquire({ priority: 'batch', deadline: far() });
    expect(pool.stats().running.batch).toBe(2);
    a.release();
    b.release();
    pool.close();
  });

  it('503 busy when the queue for a priority is full', async () => {
    const pool = mkPool({ slots: 1, maxQueue: { normal: 1, batch: 1 } });
    const held = await pool.acquire({ priority: 'normal', deadline: far() });
    const queued = pool.acquire({ priority: 'normal', deadline: far() });
    const err = await pool.acquire({ priority: 'normal', deadline: far() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).status).toBe(503);
    expect((err as GatewayError).retryAfterSec).toBeGreaterThanOrEqual(1);
    held.release();
    (await queued).release();
    pool.close();
  });

  it('503 busy (not silent drop) when the deadline passes while queued', async () => {
    const pool = mkPool({ slots: 1, initialServiceMs: 1 });
    const held = await pool.acquire({ priority: 'normal', deadline: far() });
    const err = await pool.acquire({ priority: 'normal', deadline: Date.now() + 50 }).catch((e: unknown) => e);
    expect((err as GatewayError).code).toBe('busy');
    expect(pool.stats().queued.normal).toBe(0);
    held.release();
    pool.close();
  });

  it('rejects up front when the estimated wait exceeds the timeout', async () => {
    const pool = mkPool({ slots: 1, initialServiceMs: 10_000 });
    const held = await pool.acquire({ priority: 'normal', deadline: far() });
    const err = await pool.acquire({ priority: 'normal', deadline: Date.now() + 3000 }).catch((e: unknown) => e);
    expect((err as GatewayError).status).toBe(503);
    held.release();
    pool.close();
  });

  it('removes a waiter when the client aborts', async () => {
    const pool = mkPool({ slots: 1 });
    const held: Lease = await pool.acquire({ priority: 'normal', deadline: far() });
    const ac = new AbortController();
    const p = pool.acquire({ priority: 'normal', deadline: far(), signal: ac.signal }).catch((e: GatewayError) => e.code);
    ac.abort();
    expect(await p).toBe('client_closed');
    expect(pool.stats().queued.normal).toBe(0);
    held.release();
    pool.close();
  });
});

describe('off-peak window', () => {
  const at = (h: number, m = 0): Date => new Date(2026, 0, 1, h, m);
  it('handles same-day and wrapping windows', () => {
    expect(isOffPeak('01:00-07:00', at(3))).toBe(true);
    expect(isOffPeak('01:00-07:00', at(7))).toBe(false);
    expect(isOffPeak('01:00-07:00', at(12))).toBe(false);
    expect(isOffPeak('22:00-06:00', at(23, 30))).toBe(true);
    expect(isOffPeak('22:00-06:00', at(5, 59))).toBe(true);
    expect(isOffPeak('22:00-06:00', at(6))).toBe(false);
  });
});

describe('auth', () => {
  it('identifies products by sha256 key hash', () => {
    const ks = new KeyStore({ mesgai: sha256Hex('k1'), tokofy: sha256Hex('k2') });
    expect(ks.identify('k1')).toBe('mesgai');
    expect(ks.identify('k2')).toBe('tokofy');
    expect(ks.identify('nope')).toBeNull();
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('Basic abc')).toBeNull();
  });

  it('matches IPs and CIDRs, including v4-mapped v6', () => {
    const al = new IpAllowList(['127.0.0.1', '10.1.0.0/16', '::1']);
    expect(al.allows('127.0.0.1')).toBe(true);
    expect(al.allows('::ffff:127.0.0.1')).toBe(true);
    expect(al.allows('10.1.200.3')).toBe(true);
    expect(al.allows('10.2.0.1')).toBe(false);
    expect(al.allows('::1')).toBe(true);
    expect(al.allows('8.8.8.8')).toBe(false);
    expect(al.allows(undefined)).toBe(false);
  });
});

describe('rate limiter', () => {
  it('per-subtenant rpm/concurrency → subtenant_limit; tenant totals → tenant_limit', () => {
    let t = 0;
    const rl = new RateLimiter(
      {
        default_tenant: { requests_per_min: 3, concurrent: 10 },
        default_subtenant: { requests_per_min: 2, concurrent: 1 },
        tenants: {},
        subtenants: {},
      },
      () => t,
    );
    const code = (fn: () => unknown): string | undefined => {
      try {
        fn();
      } catch (e) {
        return (e as GatewayError).code;
      }
      return undefined;
    };
    const r1 = rl.enter('p', 'a');
    expect(code(() => rl.enter('p', 'a'))).toBe('subtenant_limit'); // concurrent
    r1();
    rl.enter('p', 'a')();
    expect(code(() => rl.enter('p', 'a'))).toBe('subtenant_limit'); // rpm
    rl.enter('p', 'b')(); // other business unaffected
    expect(code(() => rl.enter('p', 'c'))).toBe('tenant_limit');
    t += 60_000;
    expect(() => rl.enter('p', 'a')()).not.toThrow();
  });
});

describe('think filter', () => {
  it('strips a leading think block in full and streaming modes', () => {
    expect(stripThink('<think>\n\n</think>\n\nHello')).toBe('Hello');
    expect(stripThink('Hello <think>x</think>')).toBe('Hello <think>x</think>');
    const f = new ThinkFilter();
    const out = ['<thi', 'nk>\n', '</think>', '\n\nSal', 'am'].map((c) => f.push(c)).join('') + f.flush();
    expect(out).toBe('Salam');
    const g = new ThinkFilter();
    expect(['Hel', 'lo'].map((c) => g.push(c)).join('') + g.flush()).toBe('Hello');
  });
});

describe('config', () => {
  it('loads the repo config files and keeps the spec task table', () => {
    const f = loadFileConfig(CONFIG_DIR);
    expect(f.tasks.tasks.reply).toMatchObject({ model: 'qwen3-4b', priority: 'normal', timeout_ms: 25000, max_tokens: 250 });
    expect(f.tasks.tasks['classify.safety']).toMatchObject({ timeout_ms: 1500, max_tokens: 20, fast: true });
    expect(f.tasks.tasks.transcribe?.timeout_ms).toBe(60000);
    expect(f.limits.defaults.timeout_ms.realtime).toBe(2000);
    expect(f.tasks.tasks['extract.order']?.json_schema).toBe(true);
    expect(f.tasks.tasks.summary?.priority).toBe('batch');
    expect(f.tasks.models['qwen3-4b']?.think).toBe(false);
    expect(f.limits.pools.llm.slots).toBe(2);
  });

  it('rejects malformed PRODUCT_KEYS', () => {
    expect(() => loadEnv({ PRODUCT_KEYS: '{"a":"plaintext"}' })).toThrow(/PRODUCT_KEYS/);
    expect(loadEnv({}).GATEWAY_BIND).toBe('127.0.0.1');
  });
});

describe('usage store migration', () => {
  it('renames the v0 `tenant` column to `subtenant` and keeps rows', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const Database = (await import('better-sqlite3')).default;
    const { UsageStore } = await import('../src/usage.js');
    const path = join(mkdtempSync(join(tmpdir(), 'kq-')), 'usage.db');
    const old = new Database(path);
    old.exec(`CREATE TABLE usage (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, request_id TEXT NOT NULL,
      product TEXT NOT NULL, tenant TEXT NOT NULL, task TEXT NOT NULL, model TEXT NOT NULL, priority TEXT NOT NULL,
      status INTEGER NOT NULL, error_code TEXT, queue_ms INTEGER NOT NULL DEFAULT 0, latency_ms INTEGER NOT NULL DEFAULT 0,
      tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, audio_seconds REAL NOT NULL DEFAULT 0,
      chars INTEGER NOT NULL DEFAULT 0, stream INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX usage_tenant_ts ON usage (product, tenant, ts);
      INSERT INTO usage (ts, request_id, product, tenant, task, model, priority, status) VALUES (1000, 'r', 'mesgai', 'biz-1', 'reply', 'qwen3-4b', 'realtime', 200);`);
    old.close();
    const store = new UsageStore(path);
    expect(store.byTask('mesgai', 0, 2000, 'biz-1').reply?.calls).toBe(1);
    store.close();
  });
});

describe('language helpers', () => {
  it('guesses language from script and common words', async () => {
    const { guessLanguage, canonicalTag, sameLanguage } = await import('../src/lang.js');
    expect(guessLanguage('آپ کا آرڈر تیار ہے').code).toBe('ur');
    expect(guessLanguage('طلبك جاهز').code).toBe('ar');
    expect(guessLanguage('आपका ऑर्डर तैयार है').code).toBe('hi');
    expect(guessLanguage('Kya aap kal delivery kar sakte hain?').code).toBe('ur-Latn');
    expect(guessLanguage('Can you deliver it tomorrow please?').code).toBe('en');
    expect(guessLanguage('Hola, ¿pueden entregar mañana?').code).toBe('es');
    expect(guessLanguage('Olá, vocês entregam amanhã?').code).toBe('pt');
    expect(guessLanguage('👍 123').code).toBeNull();
    expect(canonicalTag('ur-latn')).toBe('ur-Latn');
    expect(canonicalTag('AR_eg')).toBe('ar-EG');
    expect(sameLanguage('ar-EG', 'ar')).toBe(true);
    expect(sameLanguage('ur', 'ur-Latn')).toBe(false);
  });

  it('decides the source language from model + guess', async () => {
    const { decideSource } = await import('../src/routes/translate.js');
    expect(decideSource('ur-Latn', { code: 'ur-Latn', strength: 0.5 })).toEqual({ lang: 'ur-Latn', confidence: 0.93 });
    expect(decideSource('es', { code: null, strength: 0 })).toEqual({ lang: 'es', confidence: 0.75 });
    expect(decideSource('hi', { code: 'ur', strength: 0.95 })).toEqual({ lang: 'ur', confidence: 0.6 });
    expect(decideSource('hi-Latn', { code: 'ur-Latn', strength: 0.4 })).toEqual({ lang: 'hi-Latn', confidence: 0.55 });
    expect(decideSource(null, { code: null, strength: 0 })).toEqual({ lang: null, confidence: 0 });
  });
});
