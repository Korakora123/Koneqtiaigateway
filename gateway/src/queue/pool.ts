import { busy, GatewayError } from '../errors.js';
import { PRIORITIES, type Priority } from '../config/files.js';

export interface PoolOptions {
  name: string;
  slots: number;
  maxQueue: Record<Priority, number>;
  initialServiceMs: number;
  /** Max batch jobs running at once outside the off-peak window. */
  peakMaxBatch: number;
  isOffPeak: () => boolean;
  now?: () => number;
}

export interface AcquireOptions {
  priority: Priority;
  /** Absolute epoch-ms deadline for the whole request (queue + run). */
  deadline: number;
  signal?: AbortSignal;
}

export interface Lease {
  readonly queueMs: number;
  /** Frees the slot. Safe to call more than once. `ok=false` keeps the sample out of the run-time estimate. */
  release(ok?: boolean): void;
}

interface Waiter {
  priority: Priority;
  enqueuedAt: number;
  resolve: (lease: Lease) => void;
  reject: (err: Error) => void;
  cleanup: () => void;
}

export interface PoolStats {
  name: string;
  slots: number;
  queued: Record<Priority, number>;
  running: Record<Priority, number>;
  avgServiceMs: number;
  offPeak: boolean;
}

/**
 * Fixed-slot priority queue: realtime > interactive > batch, FIFO inside a priority.
 * Batch runs in the off-peak window, or at peak only when no realtime job is waiting
 * (and at most `peakMaxBatch` at once, so a realtime request always finds a slot).
 * A job that cannot start before its deadline gets `503 busy` + Retry-After — never dropped silently.
 */
export class PriorityPool {
  private readonly queues: Record<Priority, Waiter[]> = { realtime: [], interactive: [], batch: [] };
  private readonly running: Record<Priority, number> = { realtime: 0, interactive: 0, batch: 0 };
  private avgServiceMs: number;
  private readonly now: () => number;
  private readonly ticker: NodeJS.Timeout;

  constructor(private readonly opts: PoolOptions) {
    this.avgServiceMs = opts.initialServiceMs;
    this.now = opts.now ?? Date.now;
    // Re-check periodically so batch jobs start when the off-peak window opens.
    this.ticker = setInterval(() => this.pump(), 15_000);
    this.ticker.unref();
  }

  get name(): string {
    return this.opts.name;
  }

  close(): void {
    clearInterval(this.ticker);
    for (const p of PRIORITIES) {
      for (const w of this.queues[p].splice(0)) {
        w.cleanup();
        w.reject(busy(5, 'gateway shutting down'));
      }
    }
  }

  stats(): PoolStats {
    return {
      name: this.opts.name,
      slots: this.opts.slots,
      queued: { realtime: this.queues.realtime.length, interactive: this.queues.interactive.length, batch: this.queues.batch.length },
      running: { ...this.running },
      avgServiceMs: Math.round(this.avgServiceMs),
      offPeak: this.opts.isOffPeak(),
    };
  }

  private totalRunning(): number {
    return this.running.realtime + this.running.interactive + this.running.batch;
  }

  /** Rough wait for a new job of this priority: jobs ahead of it ÷ slots × average run time. */
  estimateWaitMs(priority: Priority): number {
    const idx = PRIORITIES.indexOf(priority);
    let ahead = 0;
    for (let i = 0; i <= idx; i++) ahead += this.queues[PRIORITIES[i]!].length;
    const free = this.opts.slots - this.totalRunning();
    if (free > 0 && ahead < free && this.canStart(priority)) return 0;
    return (ahead / this.opts.slots) * this.avgServiceMs + this.avgServiceMs / 2;
  }

  acquire(o: AcquireOptions): Promise<Lease> {
    const { priority, deadline, signal } = o;
    if (signal?.aborted) return Promise.reject(new GatewayError(499, 'client_closed', 'client closed request'));

    const q = this.queues[priority];
    if (q.length >= this.opts.maxQueue[priority]) {
      return Promise.reject(busy(this.estimateWaitMs(priority) / 1000, `${this.opts.name} queue full`));
    }
    const remaining = deadline - this.now();
    const est = this.estimateWaitMs(priority);
    if (remaining <= 0 || (priority !== 'batch' && est > remaining)) {
      return Promise.reject(busy(est / 1000, `${this.opts.name} cannot start within timeout`));
    }

    return new Promise<Lease>((resolve, reject) => {
      const enqueuedAt = this.now();
      const onAbort = (): void => {
        if (this.remove(waiter)) reject(new GatewayError(499, 'client_closed', 'client closed request'));
      };
      const timer = setTimeout(() => {
        if (this.remove(waiter)) reject(busy(this.estimateWaitMs(priority) / 1000, `${this.opts.name} queue wait exceeded timeout`));
      }, Math.max(0, remaining));
      timer.unref();
      const waiter: Waiter = {
        priority,
        enqueuedAt,
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        },
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      q.push(waiter);
      this.pump();
    });
  }

  private remove(w: Waiter): boolean {
    const q = this.queues[w.priority];
    const i = q.indexOf(w);
    if (i < 0) return false;
    q.splice(i, 1);
    w.cleanup();
    return true;
  }

  private canStart(priority: Priority): boolean {
    if (priority !== 'batch') return true;
    if (this.opts.isOffPeak()) return true;
    return this.queues.realtime.length === 0 && this.running.batch < this.opts.peakMaxBatch;
  }

  private pump(): void {
    while (this.totalRunning() < this.opts.slots) {
      const next = PRIORITIES.find((p) => this.queues[p].length > 0 && this.canStart(p));
      if (!next) return;
      const w = this.queues[next].shift()!;
      w.cleanup();
      this.running[next]++;
      const startedAt = this.now();
      let released = false;
      w.resolve({
        queueMs: startedAt - w.enqueuedAt,
        release: (ok = true) => {
          if (released) return;
          released = true;
          this.running[next]--;
          if (ok) this.avgServiceMs = this.avgServiceMs * 0.8 + (this.now() - startedAt) * 0.2;
          this.pump();
        },
      });
    }
  }
}
