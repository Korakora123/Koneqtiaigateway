import { busy, GatewayError } from '../errors.js';
import type { Priority } from '../config/files.js';

type QueuedPriority = 'normal' | 'batch';

export interface PoolOptions {
  name: string;
  /** General workers shared by normal and batch (and realtime when one is free). */
  slots: number;
  /** Extra workers only realtime may use. */
  reservedRealtime?: number;
  maxQueue: Record<QueuedPriority, number>;
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
  /** Jump ahead of other normal jobs. */
  fast?: boolean;
  signal?: AbortSignal;
}

export interface Lease {
  readonly queueMs: number;
  /** Frees the slot. Safe to call more than once. `ok=false` keeps the sample out of the run-time estimate. */
  release(ok?: boolean): void;
}

interface Waiter {
  priority: QueuedPriority;
  fast: boolean;
  enqueuedAt: number;
  resolve: (lease: Lease) => void;
  reject: (err: Error) => void;
  cleanup: () => void;
}

export interface PoolStats {
  name: string;
  slots: number;
  reservedRealtime: number;
  queued: Record<Priority, number>;
  running: Record<Priority, number>;
  avgServiceMs: number;
  offPeak: boolean;
}

const closed = (): GatewayError => new GatewayError(499, 'client_closed', 'client closed request');

/**
 * Worker pool with three priorities (master spec §3.1, MesgAI handover §1.4):
 * - realtime: never queued. Takes a reserved realtime slot, else a free general slot,
 *   else 503 at once with a short Retry-After (a caller on the phone can't wait).
 * - normal: FIFO on the general slots; `fast` jobs (short classify calls) go first.
 * - batch: yields to normal. Off-peak it may use every general slot; at peak only while no
 *   normal job waits, and at most `peakMaxBatch` at once. Never uses reserved slots.
 * A queued job that can't start before its deadline gets 503 busy + Retry-After — never dropped.
 */
export class PriorityPool {
  private readonly queues: Record<QueuedPriority, Waiter[]> = { normal: [], batch: [] };
  private readonly running: Record<Priority, number> = { realtime: 0, normal: 0, batch: 0 };
  private realtimeReserved = 0;
  private realtimeGeneral = 0;
  private avgServiceMs: number;
  private readonly reserved: number;
  private readonly now: () => number;
  private readonly ticker: NodeJS.Timeout;

  constructor(private readonly opts: PoolOptions) {
    this.avgServiceMs = opts.initialServiceMs;
    this.reserved = opts.reservedRealtime ?? 0;
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
    for (const p of ['normal', 'batch'] as const) {
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
      reservedRealtime: this.reserved,
      queued: { realtime: 0, normal: this.queues.normal.length, batch: this.queues.batch.length },
      running: { ...this.running },
      avgServiceMs: Math.round(this.avgServiceMs),
      offPeak: this.opts.isOffPeak(),
    };
  }

  private generalBusy(): number {
    return this.running.normal + this.running.batch + this.realtimeGeneral;
  }

  /** Rough wait for a new job of this priority: jobs ahead of it ÷ slots × average run time. */
  estimateWaitMs(priority: Priority, fast = false): number {
    if (priority === 'realtime') return this.avgServiceMs / 2;
    const normalAhead = fast ? this.queues.normal.filter((w) => w.fast).length : this.queues.normal.length;
    const ahead = priority === 'batch' ? this.queues.normal.length + this.queues.batch.length : normalAhead;
    const free = this.opts.slots - this.generalBusy();
    if (free > 0 && ahead < free && this.canStart(priority)) return 0;
    return (ahead / this.opts.slots) * this.avgServiceMs + this.avgServiceMs / 2;
  }

  acquire(o: AcquireOptions): Promise<Lease> {
    const { priority, deadline, signal } = o;
    if (signal?.aborted) return Promise.reject(closed());
    if (priority === 'realtime') return this.acquireRealtime();

    const q = this.queues[priority];
    if (q.length >= this.opts.maxQueue[priority]) {
      return Promise.reject(busy(this.estimateWaitMs(priority) / 1000, `${this.opts.name} queue full`));
    }
    const remaining = deadline - this.now();
    const est = this.estimateWaitMs(priority, o.fast);
    if (remaining <= 0 || (priority !== 'batch' && est > remaining)) {
      return Promise.reject(busy(est / 1000, `${this.opts.name} cannot start within timeout`));
    }

    return new Promise<Lease>((resolve, reject) => {
      const onAbort = (): void => {
        if (this.remove(waiter)) reject(closed());
      };
      const timer = setTimeout(() => {
        if (this.remove(waiter)) reject(busy(this.estimateWaitMs(priority) / 1000, `${this.opts.name} queue wait exceeded timeout`));
      }, Math.max(0, remaining));
      timer.unref();
      const waiter: Waiter = {
        priority,
        fast: Boolean(o.fast) && priority === 'normal',
        enqueuedAt: this.now(),
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        },
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (waiter.fast) {
        const firstSlow = q.findIndex((w) => !w.fast);
        q.splice(firstSlow < 0 ? q.length : firstSlow, 0, waiter);
      } else {
        q.push(waiter);
      }
      this.pump();
    });
  }

  private acquireRealtime(): Promise<Lease> {
    let kind: 'reserved' | 'general';
    if (this.realtimeReserved < this.reserved) kind = 'reserved';
    else if (this.generalBusy() < this.opts.slots) kind = 'general';
    else return Promise.reject(busy(1, `${this.opts.name} realtime workers busy`));

    if (kind === 'reserved') this.realtimeReserved++;
    else this.realtimeGeneral++;
    this.running.realtime++;
    const startedAt = this.now();
    let released = false;
    return Promise.resolve({
      queueMs: 0,
      release: (ok = true) => {
        if (released) return;
        released = true;
        this.running.realtime--;
        if (kind === 'reserved') this.realtimeReserved--;
        else this.realtimeGeneral--;
        if (ok) this.avgServiceMs = this.avgServiceMs * 0.8 + (this.now() - startedAt) * 0.2;
        this.pump();
      },
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
    if (this.opts.isOffPeak()) return this.queues.normal.length === 0;
    return this.queues.normal.length === 0 && this.running.batch < this.opts.peakMaxBatch;
  }

  private pump(): void {
    while (this.generalBusy() < this.opts.slots) {
      const next = (['normal', 'batch'] as const).find((p) => this.queues[p].length > 0 && this.canStart(p));
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
