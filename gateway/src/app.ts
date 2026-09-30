import { randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { ZodError } from 'zod';
import type { Env } from './config/env.js';
import { loadFileConfig, type FileConfig } from './config/files.js';
import { bearerToken, IpAllowList, KeyStore } from './auth.js';
import { RateLimiter } from './ratelimit.js';
import { PriorityPool } from './queue/pool.js';
import { isOffPeak } from './queue/offpeak.js';
import { UsageStore } from './usage.js';
import { Metrics } from './metrics.js';
import { OllamaClient } from './backends/ollama.js';
import { SpeechClient, TtsClient } from './backends/audio.js';
import { GatewayError, busy } from './errors.js';
import { newCtx, requireTenant, sendError, usageHeader } from './context.js';
import type { Deps } from './deps.js';
import { registerChat } from './routes/chat.js';
import { registerTranscriptions } from './routes/transcriptions.js';
import { registerSpeech } from './routes/speech.js';
import { registerVoices, registerEmbeddings } from './routes/voices.js';
import { registerSafety } from './routes/safety.js';
import { registerModels, registerUsage } from './routes/models.js';
import { registerHealth } from './routes/health.js';

export interface BuildOptions {
  env: Env;
  files?: FileConfig;
  /** Override pieces in tests. */
  overrides?: Partial<Deps>;
  /** Where logs go (tests capture them to prove no content is logged). Default stdout. */
  logStream?: NodeJS.WritableStream;
  now?: () => Date;
}

export function buildDeps(env: Env, files: FileConfig, now: () => Date = () => new Date()): Deps {
  const L = files.limits;
  const offPeak = (): boolean => isOffPeak(env.OFFPEAK_WINDOW, now());
  const pool = (name: 'llm' | 'speech' | 'tts', slots: number): PriorityPool =>
    new PriorityPool({
      name,
      slots,
      maxQueue: L.pools[name].max_queue,
      initialServiceMs: L.defaults.initial_service_ms[name],
      peakMaxBatch: L.batch.peak_max_concurrent,
      isOffPeak: offPeak,
    });
  // llm slots must match what Ollama really runs in parallel.
  const llmSlots = env.OLLAMA_NUM_PARALLEL ?? L.pools.llm.slots;
  const pools = { llm: pool('llm', llmSlots), speech: pool('speech', L.pools.speech.slots), tts: pool('tts', L.pools.tts.slots) };
  return {
    env,
    files,
    keys: new KeyStore(env.PRODUCT_KEYS),
    allowList: new IpAllowList(env.ALLOWED_IPS),
    rateLimiter: new RateLimiter(L.rate_limits),
    pools,
    usage: new UsageStore(env.USAGE_DB_PATH),
    metrics: new Metrics(Object.values(pools)),
    ollama: new OllamaClient(env.OLLAMA_URL),
    speech: new SpeechClient(env.SPEECH_URL),
    tts: new TtsClient(env.TTS_URL),
  };
}

/** Routes under /v1 that do not need X-Tenant-Id. */
const TENANT_OPTIONAL = new Set(['/v1/models', '/v1/usage']);

export async function buildApp(opts: BuildOptions): Promise<{ app: FastifyInstance; deps: Deps }> {
  const files = opts.files ?? loadFileConfig(opts.env.CONFIG_DIR);
  const deps: Deps = { ...buildDeps(opts.env, files, opts.now), ...opts.overrides };
  const { env, metrics } = deps;

  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      ...(opts.logStream ? { stream: opts.logStream } : {}),
      // Metadata only (CLAUDE.md rule 4): never log bodies, and never the key.
      redact: ['req.headers.authorization'],
      serializers: {
        req: (r: { method: string; url: string }) => ({ method: r.method, path: r.url.split('?')[0] }),
        res: (r: { statusCode: number }) => ({ status: r.statusCode }),
      },
    },
    // We log one metadata-only line per request ourselves (onResponse).
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: () => randomUUID(),
    trustProxy: env.TRUST_PROXY,
    bodyLimit: files.limits.request.max_body_bytes,
  });

  await app.register(multipart, { limits: { fileSize: files.limits.request.max_audio_bytes, files: 1, fields: 10 } });

  app.decorateRequest('ctx', null as never);

  app.addHook('onRequest', async (req, reply) => {
    const ctx = newCtx(req.id);
    req.ctx = ctx;
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) ctx.clientAbort.abort();
      ctx.releaseRate?.();
    });

    if (!deps.allowList.allows(req.ip)) {
      metrics.rejections.inc({ reason: 'ip_not_allowed', pool: '' });
      throw new GatewayError(403, 'ip_not_allowed', 'source address not allowed');
    }
    const path = req.url.split('?')[0]!;
    if (!path.startsWith('/v1/')) return; // /health, /metrics: IP allowlist only

    const token = bearerToken(req.headers.authorization);
    const product = token ? deps.keys.identify(token) : null;
    if (!product) {
      metrics.rejections.inc({ reason: 'bad_key', pool: '' });
      throw new GatewayError(401, 'invalid_product_key', 'missing or invalid product key');
    }
    ctx.product = product;
    if (!TENANT_OPTIONAL.has(path)) ctx.tenant = requireTenant(req);
    else if (typeof req.headers['x-tenant-id'] === 'string') ctx.tenant = requireTenant(req);
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const ctx = req.ctx;
    if (!ctx) return payload;
    reply.header('x-request-id', ctx.requestId);
    if (!reply.hasHeader('x-model-used')) reply.header('x-model-used', ctx.model);
    if (!reply.hasHeader('x-queue-ms')) reply.header('x-queue-ms', String(ctx.queueMs));
    if (!reply.hasHeader('x-usage')) reply.header('x-usage', usageHeader(ctx));
    return payload;
  });

  app.addHook('onResponse', async (req, reply) => {
    const ctx = req.ctx;
    if (!ctx) return;
    ctx.releaseRate?.();
    const latency = Date.now() - ctx.startedAt;
    const route = req.routeOptions.url ?? 'unknown';
    const status = ctx.clientAbort.signal.aborted && !reply.raw.writableFinished ? 499 : reply.statusCode;
    const task = ctx.task ?? '';
    metrics.requests.inc({ route, status: String(status), product: ctx.product ?? '', task });
    metrics.latency.observe({ route, task }, latency / 1000);
    if (ctx.tokensIn || ctx.tokensOut) {
      metrics.tokens.inc({ product: ctx.product ?? '', task, direction: 'in' }, ctx.tokensIn);
      metrics.tokens.inc({ product: ctx.product ?? '', task, direction: 'out' }, ctx.tokensOut);
    }
    if (task === 'reply' && status === 200) metrics.replyWindow.push(latency);
    if (status === 503) metrics.rejections.inc({ reason: 'busy', pool: '' });
    if (status === 429) metrics.rejections.inc({ reason: 'rate_limited', pool: '' });

    if (ctx.product && ctx.task) {
      try {
        deps.usage.record({
          ts: ctx.startedAt,
          request_id: ctx.requestId,
          product: ctx.product,
          tenant: ctx.tenant ?? '',
          task: ctx.task,
          model: ctx.model,
          priority: ctx.priority ?? '',
          status,
          error_code: ctx.errorCode,
          queue_ms: ctx.queueMs,
          latency_ms: latency,
          tokens_in: ctx.tokensIn,
          tokens_out: ctx.tokensOut,
          audio_seconds: ctx.audioSeconds,
          chars: ctx.chars,
          stream: ctx.stream ? 1 : 0,
        });
      } catch (err) {
        req.log.error({ err: { message: (err as Error).message } }, 'usage write failed');
      }
    }
    if (route === '/health' || route === '/metrics') return;
    // Metadata only: product, tenant, task, model, tokens/seconds, queue time, latency, status.
    req.log.info(
      {
        rid: ctx.requestId,
        product: ctx.product,
        tenant: ctx.tenant,
        task: ctx.task,
        model: ctx.model,
        priority: ctx.priority,
        status,
        err: ctx.errorCode ?? undefined,
        queue_ms: ctx.queueMs,
        latency_ms: latency,
        tokens_in: ctx.tokensIn || undefined,
        tokens_out: ctx.tokensOut || undefined,
        audio_s: ctx.audioSeconds || undefined,
        chars: ctx.chars || undefined,
        stream: ctx.stream || undefined,
      },
      'request',
    );
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof GatewayError) return sendError(reply, err);
    if (err instanceof ZodError) {
      const detail = err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
      return sendError(reply, new GatewayError(400, 'invalid_request', detail.slice(0, 500)));
    }
    const e = err as { statusCode?: number; code?: string; name?: string; message?: string };
    if (e.name === 'AbortError' || e.name === 'TimeoutError') return sendError(reply, busy(5, 'request aborted'));
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      const code = e.statusCode === 413 ? 'payload_too_large' : e.statusCode === 415 ? 'unsupported_media_type' : 'invalid_request';
      // Fastify's own messages (e.g. invalid JSON) don't include body content.
      return sendError(reply, new GatewayError(e.statusCode, code, e.message ?? 'invalid request'));
    }
    req.log.error({ err: { name: e.name, code: e.code, message: e.message, stack: (err as Error).stack } }, 'unhandled error');
    return sendError(reply, new GatewayError(500, 'internal_error', 'internal error'));
  });

  app.setNotFoundHandler((_req, reply) => sendError(reply, new GatewayError(404, 'not_found', 'route not found')));

  registerHealth(app, deps);
  registerModels(app, deps);
  registerUsage(app, deps);
  registerChat(app, deps);
  registerTranscriptions(app, deps);
  registerSpeech(app, deps);
  registerSafety(app, deps);
  registerVoices(app, deps);
  registerEmbeddings(app);

  const sweeper = setInterval(() => deps.rateLimiter.sweep(), 60_000);
  sweeper.unref();
  const pruner = setInterval(() => deps.usage.prune(env.USAGE_RETENTION_DAYS), 86_400_000);
  pruner.unref();
  app.addHook('onClose', async () => {
    clearInterval(sweeper);
    clearInterval(pruner);
    for (const p of Object.values(deps.pools)) p.close();
    deps.usage.close();
  });

  return { app, deps };
}
