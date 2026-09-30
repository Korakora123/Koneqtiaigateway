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
    maxQueue: { realtime: 4, interactive: 4, batch: 4 },
    initialServiceMs: 100,
    peakMaxBatch: 1,
    isOffPeak: () => false,
    ...o,
  });
}

describe('PriorityPool', () => {
  it('serves realtime before interactive before batch (FIFO inside a priority)', async () => {
    const pool = mkPool({ slots: 1, isOffPeak: () => true });
    const first = await pool.acquire({ priority: 'interactive', deadline: far() });
    const order: string[] = [];
    const take = (name: string, priority: 'realtime' | 'interactive' | 'batch'): Promise<void> =>
      pool.acquire({ priority, deadline: far() }).then((l) => {
        order.push(name);
        l.release();
      });
    const all = Promise.all([take('b1', 'batch'), take('i1', 'interactive'), take('r1', 'realtime'), take('r2', 'realtime')]);
    first.release();
    await all;
    expect(order).toEqual(['r1', 'r2', 'i1', 'b1']);
    pool.close();
  });

  it('holds batch at peak while realtime is waiting, and caps batch concurrency', async () => {
    const pool = mkPool({ slots: 2, isOffPeak: () => false, peakMaxBatch: 1 });
    const b1 = await pool.acquire({ priority: 'batch', deadline: far() });
    let b2Started = false;
    const b2 = pool.acquire({ priority: 'batch', deadline: far() }).then((l) => {
      b2Started = true;
      return l;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(b2Started).toBe(false); // one slot free, but peak cap = 1 batch
    const r1 = await pool.acquire({ priority: 'realtime', deadline: far() });
    expect(pool.stats().running.realtime).toBe(1);
    b1.release();
    await new Promise((r) => setTimeout(r, 20));
    expect(b2Started).toBe(true);
    (await b2).release();
    r1.release();
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
    const pool = mkPool({ slots: 1, maxQueue: { realtime: 1, interactive: 1, batch: 1 } });
    const held = await pool.acquire({ priority: 'realtime', deadline: far() });
    const queued = pool.acquire({ priority: 'realtime', deadline: far() });
    const err = await pool.acquire({ priority: 'realtime', deadline: far() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).status).toBe(503);
    expect((err as GatewayError).retryAfterSec).toBeGreaterThanOrEqual(1);
    held.release();
    (await queued).release();
    pool.close();
  });

  it('503 busy (not silent drop) when the deadline passes while queued', async () => {
    const pool = mkPool({ slots: 1, initialServiceMs: 1 });
    const held = await pool.acquire({ priority: 'realtime', deadline: far() });
    const err = await pool.acquire({ priority: 'realtime', deadline: Date.now() + 50 }).catch((e: unknown) => e);
    expect((err as GatewayError).code).toBe('busy');
    expect(pool.stats().queued.realtime).toBe(0);
    held.release();
    pool.close();
  });

  it('rejects up front when the estimated wait exceeds the timeout', async () => {
    const pool = mkPool({ slots: 1, initialServiceMs: 10_000 });
    const held = await pool.acquire({ priority: 'realtime', deadline: far() });
    const err = await pool.acquire({ priority: 'realtime', deadline: Date.now() + 3000 }).catch((e: unknown) => e);
    expect((err as GatewayError).status).toBe(503);
    held.release();
    pool.close();
  });

  it('removes a waiter when the client aborts', async () => {
    const pool = mkPool({ slots: 1 });
    const held: Lease = await pool.acquire({ priority: 'realtime', deadline: far() });
    const ac = new AbortController();
    const p = pool.acquire({ priority: 'realtime', deadline: far(), signal: ac.signal }).catch((e: GatewayError) => e.code);
    ac.abort();
    expect(await p).toBe('client_closed');
    expect(pool.stats().queued.realtime).toBe(0);
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
  it('enforces per-tenant rpm and concurrency, and per-product totals', () => {
    let t = 0;
    const rl = new RateLimiter(
      {
        default_product: { requests_per_min: 3, concurrent: 10 },
        default_tenant: { requests_per_min: 2, concurrent: 1 },
        products: {},
        tenants: {},
      },
      () => t,
    );
    const r1 = rl.enter('p', 'a');
    expect(() => rl.enter('p', 'a')).toThrow(/concurrent/);
    r1();
    rl.enter('p', 'a')();
    expect(() => rl.enter('p', 'a')).toThrow(/rate limit/);
    rl.enter('p', 'b')();
    expect(() => rl.enter('p', 'c')).toThrow(/product request rate/);
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
    expect(f.tasks.tasks.reply).toMatchObject({ model: 'qwen3-4b', priority: 'realtime', timeout_ms: 25000, max_tokens: 250 });
    expect(f.tasks.tasks['classify.safety']).toMatchObject({ timeout_ms: 3000, max_tokens: 20 });
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
