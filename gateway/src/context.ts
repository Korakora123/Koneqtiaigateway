import type { FastifyReply, FastifyRequest } from 'fastify';
import { PRIORITIES, PriorityEnum, timeoutFor, type Priority, type TaskConfig } from './config/files.js';
import { busy, GatewayError } from './errors.js';
import type { Deps } from './deps.js';
import type { PriorityPool } from './queue/pool.js';

/** Per-request metadata. Everything here may be logged / stored — never put content in it. */
export interface RequestCtx {
  requestId: string;
  startedAt: number;
  product: string | null;
  tenant: string | null;
  task: string | null;
  priority: Priority | null;
  model: string;
  queueMs: number;
  tokensIn: number;
  tokensOut: number;
  audioSeconds: number;
  chars: number;
  stream: boolean;
  errorCode: string | null;
  /** Aborted when the client disconnects. */
  clientAbort: AbortController;
  releaseRate: (() => void) | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    ctx: RequestCtx;
  }
}

const TENANT_RE = /^[A-Za-z0-9._:@-]{1,128}$/;

export function newCtx(requestId: string): RequestCtx {
  return {
    requestId,
    startedAt: Date.now(),
    product: null,
    tenant: null,
    task: null,
    priority: null,
    model: 'none',
    queueMs: 0,
    tokensIn: 0,
    tokensOut: 0,
    audioSeconds: 0,
    chars: 0,
    stream: false,
    errorCode: null,
    clientAbort: new AbortController(),
    releaseRate: null,
  };
}

export function usageHeader(ctx: RequestCtx): string {
  const parts: string[] = [];
  if (ctx.tokensIn || ctx.tokensOut) parts.push(`tokens_in=${ctx.tokensIn}`, `tokens_out=${ctx.tokensOut}`);
  if (ctx.audioSeconds) parts.push(`audio_seconds=${ctx.audioSeconds.toFixed(2)}`);
  if (ctx.chars) parts.push(`chars=${ctx.chars}`);
  return parts.length ? parts.join(';') : 'none';
}

export interface ResolvedTask {
  name: string;
  cfg: TaskConfig;
  priority: Priority;
  deadline: number;
}

/**
 * Resolves X-Task (or a route's fixed task) against tasks.yaml, applies X-Priority (may only
 * lower priority) and X-Max-Latency-Ms (may only shorten the timeout), and takes a rate-limit slot.
 */
export function resolveTask(
  req: FastifyRequest,
  deps: Deps,
  opts: { fixedTask?: string; defaultTask?: string; service: TaskConfig['service'] },
): ResolvedTask {
  const header = req.headers['x-task'];
  const name = opts.fixedTask ?? (typeof header === 'string' && header ? header : opts.defaultTask);
  if (!name) throw new GatewayError(400, 'task_required', 'X-Task header is required');
  const cfg = deps.files.tasks.tasks[name];
  if (!cfg) throw new GatewayError(400, 'unknown_task', `unknown task: ${name}`);
  if (cfg.service !== opts.service) {
    throw new GatewayError(400, 'wrong_endpoint', `task ${name} is served by the ${cfg.service} endpoint`);
  }

  let priority = cfg.priority;
  const ph = req.headers['x-priority'];
  if (typeof ph === 'string' && ph) {
    const parsed = PriorityEnum.safeParse(ph.toLowerCase());
    if (!parsed.success) throw new GatewayError(400, 'invalid_priority', 'X-Priority must be realtime|interactive|batch');
    if (PRIORITIES.indexOf(parsed.data) > PRIORITIES.indexOf(priority)) priority = parsed.data;
  }

  let timeout = timeoutFor({ ...cfg, priority }, deps.files.limits);
  const ml = req.headers['x-max-latency-ms'];
  if (typeof ml === 'string' && ml) {
    const n = Number(ml);
    if (!Number.isFinite(n) || n <= 0) throw new GatewayError(400, 'invalid_max_latency', 'X-Max-Latency-Ms must be a positive number');
    timeout = Math.min(timeout, n);
  }

  const ctx = req.ctx;
  ctx.task = name;
  ctx.priority = priority;
  ctx.model = cfg.model;
  ctx.releaseRate = deps.rateLimiter.enter(ctx.product!, ctx.tenant!);
  return { name, cfg, priority, deadline: ctx.startedAt + timeout };
}

export function requireTenant(req: FastifyRequest): string {
  const t = req.headers['x-tenant-id'];
  if (typeof t !== 'string' || !TENANT_RE.test(t)) {
    throw new GatewayError(400, 'tenant_required', 'X-Tenant-Id header is required ([A-Za-z0-9._:@-], max 128)');
  }
  return t;
}

export interface Slot {
  /** Fires on client disconnect or when the request's deadline passes. */
  signal: AbortSignal;
  release: (ok?: boolean) => void;
  /** Converts an error thrown while using the slot: deadline miss → 503 busy, disconnect → 499. */
  mapError: (err: unknown) => unknown;
}

/** Waits for a slot in `pool` (priority queue). Callers must `release()` it when done. */
export async function acquireSlot(req: FastifyRequest, deps: Deps, pool: PriorityPool, task: ResolvedTask): Promise<Slot> {
  const ctx = req.ctx;
  const lease = await pool.acquire({ priority: task.priority, deadline: task.deadline, signal: ctx.clientAbort.signal });
  ctx.queueMs = lease.queueMs;
  deps.metrics.queueWait.observe({ pool: pool.name, priority: task.priority }, lease.queueMs / 1000);
  const remaining = task.deadline - Date.now();
  if (remaining <= 0) {
    lease.release(false);
    throw busy(pool.estimateWaitMs(task.priority) / 1000, 'deadline passed before start');
  }
  const timeout = AbortSignal.timeout(remaining);
  const signal = AbortSignal.any([ctx.clientAbort.signal, timeout]);
  return {
    signal,
    release: lease.release,
    mapError: (err) => {
      if (ctx.clientAbort.signal.aborted) return new GatewayError(499, 'client_closed', 'client closed request');
      if (timeout.aborted) {
        return busy(Math.max(pool.estimateWaitMs(task.priority), 1000) / 1000, 'request could not finish within its timeout');
      }
      return err;
    },
  };
}

/** Runs `fn` inside a slot and always releases it. */
export async function withSlot<T>(
  req: FastifyRequest,
  deps: Deps,
  pool: PriorityPool,
  task: ResolvedTask,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const slot = await acquireSlot(req, deps, pool, task);
  let ok = false;
  try {
    const v = await fn(slot.signal);
    ok = true;
    return v;
  } catch (err) {
    throw slot.mapError(err);
  } finally {
    slot.release(ok);
  }
}

export function sendError(reply: FastifyReply, err: GatewayError): FastifyReply {
  if (err.retryAfterSec !== undefined) reply.header('Retry-After', String(err.retryAfterSec));
  reply.request.ctx.errorCode = err.code;
  return reply.code(err.status).send(err.toBody());
}
