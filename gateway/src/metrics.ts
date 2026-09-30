import { readFileSync } from 'node:fs';
import os from 'node:os';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { PriorityPool } from './queue/pool.js';
import { PRIORITIES } from './config/files.js';

export interface HostStats {
  memTotalMb: number;
  memAvailableMb: number;
  memUsedPct: number;
  load1: number;
  load5: number;
  cpus: number;
}

/** Host memory from /proc/meminfo (inside Docker this is the host's view unless lxcfs is used). */
export function hostStats(): HostStats {
  let totalKb = os.totalmem() / 1024;
  let availKb = os.freemem() / 1024;
  try {
    const info = readFileSync('/proc/meminfo', 'utf8');
    const get = (k: string): number | undefined => {
      const m = new RegExp(`^${k}:\\s+(\\d+) kB`, 'm').exec(info);
      return m ? Number(m[1]) : undefined;
    };
    totalKb = get('MemTotal') ?? totalKb;
    availKb = get('MemAvailable') ?? availKb;
  } catch {
    /* non-Linux dev machine */
  }
  const [l1, l5] = os.loadavg();
  return {
    memTotalMb: Math.round(totalKb / 1024),
    memAvailableMb: Math.round(availKb / 1024),
    memUsedPct: Math.round((1 - availKb / totalKb) * 1000) / 10,
    load1: Math.round((l1 ?? 0) * 100) / 100,
    load5: Math.round((l5 ?? 0) * 100) / 100,
    cpus: os.cpus().length,
  };
}

/** Sliding window of recent latencies for a cheap p95 in /health. */
class LatencyWindow {
  private readonly values: number[] = [];
  constructor(private readonly size = 500) {}
  push(v: number): void {
    this.values.push(v);
    if (this.values.length > this.size) this.values.shift();
  }
  percentile(p: number): number | null {
    if (this.values.length === 0) return null;
    const sorted = [...this.values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
  }
  get count(): number {
    return this.values.length;
  }
}

export class Metrics {
  readonly registry = new Registry();
  readonly requests: Counter<'route' | 'status' | 'product' | 'task'>;
  readonly latency: Histogram<'route' | 'task'>;
  readonly queueWait: Histogram<'pool' | 'priority'>;
  readonly tokens: Counter<'product' | 'task' | 'direction'>;
  readonly rejections: Counter<'reason' | 'pool'>;
  /** Latency of `reply`-style realtime chat jobs — the p95 alert in spec §4.9 (> 20 s). */
  readonly replyWindow = new LatencyWindow();

  constructor(pools: PriorityPool[]) {
    collectDefaultMetrics({ register: this.registry, prefix: 'gateway_' });
    this.requests = new Counter({
      name: 'gateway_requests_total',
      help: 'Requests by route, status, product and task',
      labelNames: ['route', 'status', 'product', 'task'],
      registers: [this.registry],
    });
    this.latency = new Histogram({
      name: 'gateway_request_duration_seconds',
      help: 'End-to-end request latency',
      labelNames: ['route', 'task'],
      buckets: [0.1, 0.25, 0.5, 1, 2, 3, 5, 8, 12, 20, 30, 60, 120],
      registers: [this.registry],
    });
    this.queueWait = new Histogram({
      name: 'gateway_queue_wait_seconds',
      help: 'Time spent waiting for a backend slot',
      labelNames: ['pool', 'priority'],
      buckets: [0, 0.05, 0.25, 1, 2, 5, 10, 20, 60, 300, 1800],
      registers: [this.registry],
    });
    this.tokens = new Counter({
      name: 'gateway_tokens_total',
      help: 'Tokens processed',
      labelNames: ['product', 'task', 'direction'],
      registers: [this.registry],
    });
    this.rejections = new Counter({
      name: 'gateway_rejections_total',
      help: 'Requests rejected (busy, rate limit, auth)',
      labelNames: ['reason', 'pool'],
      registers: [this.registry],
    });
    const queued = new Gauge({
      name: 'gateway_queue_length',
      help: 'Jobs waiting per pool and priority',
      labelNames: ['pool', 'priority'],
      registers: [this.registry],
      collect() {
        for (const p of pools) {
          const s = p.stats();
          for (const pr of PRIORITIES) this.set({ pool: s.name, priority: pr }, s.queued[pr]);
        }
      },
    });
    const running = new Gauge({
      name: 'gateway_jobs_running',
      help: 'Jobs running per pool and priority',
      labelNames: ['pool', 'priority'],
      registers: [this.registry],
      collect() {
        for (const p of pools) {
          const s = p.stats();
          for (const pr of PRIORITIES) this.set({ pool: s.name, priority: pr }, s.running[pr]);
        }
      },
    });
    const hostMem = new Gauge({
      name: 'host_memory_used_percent',
      help: 'Host RAM used (MemAvailable based)',
      registers: [this.registry],
      collect() {
        this.set(hostStats().memUsedPct);
      },
    });
    const hostLoad = new Gauge({
      name: 'host_load1',
      help: 'Host 1-minute load average',
      registers: [this.registry],
      collect() {
        this.set(hostStats().load1);
      },
    });
    const p95 = new Gauge({
      name: 'gateway_reply_p95_seconds',
      help: 'p95 latency of recent realtime chat replies (window of 500)',
      registers: [this.registry],
      collect: () => {
        const v = this.replyWindow.percentile(95);
        p95.set(v === null ? 0 : v / 1000);
      },
    });
    void queued;
    void running;
    void hostMem;
    void hostLoad;
  }

  replyP95Ms(): number | null {
    return this.replyWindow.percentile(95);
  }

  replySamples(): number {
    return this.replyWindow.count;
  }
}
