import type { LimitsFile, RateLimit } from './config/files.js';
import { GatewayError } from './errors.js';

interface Counter {
  windowStart: number;
  count: number;
  concurrent: number;
}

/**
 * Per-product and per-tenant limits: requests/minute (fixed 60 s window) and concurrent requests.
 * In-memory — Stage 0 runs a single gateway process.
 */
export class RateLimiter {
  private readonly counters = new Map<string, Counter>();

  constructor(
    private readonly cfg: LimitsFile['rate_limits'],
    private readonly now: () => number = Date.now,
  ) {}

  private limitFor(kind: 'product' | 'tenant', key: string): RateLimit {
    return kind === 'product'
      ? (this.cfg.products[key] ?? this.cfg.default_product)
      : (this.cfg.tenants[key] ?? this.cfg.default_tenant);
  }

  private counter(key: string): Counter {
    const t = this.now();
    let c = this.counters.get(key);
    if (!c) {
      c = { windowStart: t, count: 0, concurrent: 0 };
      this.counters.set(key, c);
    }
    if (t - c.windowStart >= 60_000) {
      c.windowStart = t;
      c.count = 0;
    }
    return c;
  }

  /** Reserves one request for product + tenant. Returns a release function (idempotent). */
  enter(product: string, tenant: string): () => void {
    const checks = [
      { key: `p:${product}`, limit: this.limitFor('product', product), who: 'product' },
      { key: `t:${product}:${tenant}`, limit: this.limitFor('tenant', `${product}:${tenant}`), who: 'tenant' },
    ];
    for (const { key, limit, who } of checks) {
      const c = this.counter(key);
      if (c.count >= limit.requests_per_min) {
        const retry = Math.ceil((60_000 - (this.now() - c.windowStart)) / 1000);
        throw new GatewayError(429, 'rate_limited', `${who} request rate limit reached`, Math.max(1, retry));
      }
      if (c.concurrent >= limit.concurrent) {
        throw new GatewayError(429, 'too_many_concurrent', `${who} concurrent request limit reached`, 1);
      }
    }
    const held = checks.map(({ key }) => {
      const c = this.counter(key);
      c.count++;
      c.concurrent++;
      return c;
    });
    let done = false;
    return () => {
      if (done) return;
      done = true;
      for (const c of held) c.concurrent = Math.max(0, c.concurrent - 1);
    };
  }

  /** Drops idle counters so memory stays bounded with many tenants. */
  sweep(): void {
    const t = this.now();
    for (const [k, c] of this.counters) if (c.concurrent === 0 && t - c.windowStart >= 120_000) this.counters.delete(k);
  }
}
