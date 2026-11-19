import type { FastifyReply, FastifyRequest } from 'fastify';
import { PriorityEnum, timeoutFor, type Priority, type TaskConfig } from './config/files.js';
import { busy, GatewayError } from './errors.js';
import type { Deps } from './deps.js';
import type { PriorityPool } from './queue/pool.js';

/** Per-request metadata. Everything here may be logged / stored — never put content in it. */
export interface RequestCtx {
  requestId: string;
  startedAt: number;
  /** Tenant = the product/customer that owns the API key (never taken from a header). */
  product: string | null;
  /** Subtenant = one business inside the tenant (x-kq-subtenant), or `system`. */
  subtenant: string | null;
  task: string | null;
  priority: Priority | null;
  model: string;
  queueMs: number;
  tokensIn: number;
  tokensOut: number;
  evalMs: number;
  promptMs: number;
  /** Answer cache result: hit | miss | off | '' (not cacheable). */
  cache: string;
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

const ID_RE = /^[A-Za-z0-9._:@-]{1,128}$/;

export function newCtx(requestId: string): RequestCtx {
  return {
    requestId,
    startedAt: Date.now(),
    product: null,
    subtenant: null,
    task: null,
    priority: null,
    model: 'none',
    queueMs: 0,
    tokensIn: 0,
    tokensOut: 0,
    evalMs: 0,
    promptMs: 0,
    cache: '',
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
  if (ctx.promptMs) parts.push(`prompt_ms=${ctx.promptMs}`);
  if (ctx.evalMs) parts.push(`eval_ms=${ctx.evalMs}`);
  if (ctx.audioSeconds) parts.push(`audio_seconds=${ctx.audioSeconds.toFixed(2)}`);
  if (ctx.chars) parts.push(`chars=${ctx.chars}`);
  return parts.length ? parts.join(';') : 'none';
}

/** `x-kq-usage-tokens`: input + output tokens (text endpoints). */
export const usageTokens = (ctx: RequestCtx): number => ctx.tokensIn + ctx.tokensOut;

export interface ResolvedTask {
  name: string;
  cfg: TaskConfig;
  priority: Priority;
  deadline: number;
}

/** `x-kq-priority` (or legacy `X-Priority`; `interactive` = `normal`). Undefined when absent. */
export function priorityHeader(req: FastifyRequest): Priority | undefined {
  const raw = req.headers['x-kq-priority'] ?? req.headers['x-priority'];
  if (typeof raw !== 'string' || !raw) return undefined;
  const v = raw.trim().toLowerCase();
  const parsed = PriorityEnum.safeParse(v === 'interactive' ? 'normal' : v);
  if (!parsed.success) throw new GatewayError(400, 'invalid_priority', 'x-kq-priority must be realtime|normal|batch');
  return parsed.data;
}

/**
 * Resolves X-Task (or a route's fixed task) against tasks.yaml, applies x-kq-priority and
 * X-Max-Latency-Ms (may only shorten the timeout), and takes a rate-limit slot.
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

  const priority = priorityHeader(req) ?? cfg.priority;
  let timeout = timeoutFor(cfg, priority, deps.files.limits);
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
  ctx.releaseRate = deps.rateLimiter.enter(ctx.product!, ctx.subtenant!);
  return { name, cfg, priority, deadline: ctx.startedAt + timeout };
}

/**
 * Tenant comes from the key only. `X-Tenant-Id` is accepted for backward compatibility but
 * must equal the key's tenant (master spec §11.1).
 */
export function checkTenantHeader(req: FastifyRequest, product: string): void {
  const t = req.headers['x-tenant-id'];
  if (t !== undefined && t !== product) {
    throw new GatewayError(403, 'tenant_mismatch', 'X-Tenant-Id does not match the API key\'s tenant');
  }
}

/** `x-kq-subtenant`: the business id, or `system` for calls that belong to no business. */
export function readSubtenant(req: FastifyRequest, required: boolean): string | null {
  const s = req.headers['x-kq-subtenant'];
  if (s === undefined || s === '') {
    if (required) throw new GatewayError(400, 'subtenant_required', 'x-kq-subtenant header is required (business id or "system")');
    return null;
  }
  if (typeof s !== 'string' || !ID_RE.test(s)) {
    throw new GatewayError(400, 'invalid_subtenant', 'x-kq-subtenant must match [A-Za-z0-9._:@-], max 128');
  }
  return s;
}

/** Caller's `X-Request-Id` is echoed back (tracing); otherwise a new UUID. */
export function requestIdFrom(header: string | string[] | undefined, fallback: () => string): string {
  return typeof header === 'string' && ID_RE.test(header) ? header : fallback();
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
  const lease = await pool.acquire({
    priority: task.priority,
    deadline: task.deadline,
    fast: task.cfg.fast,
    signal: ctx.clientAbort.signal,
  });
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
