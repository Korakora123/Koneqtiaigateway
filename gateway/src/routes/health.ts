import type { FastifyInstance } from 'fastify';
import type { Deps } from '../deps.js';
import { hostStats } from '../metrics.js';

async function probe(fn: (s: AbortSignal) => Promise<boolean>): Promise<boolean> {
  try {
    return await fn(AbortSignal.timeout(1500));
  } catch {
    return false;
  }
}

export function registerHealth(app: FastifyInstance, deps: Deps): void {
  const ollamaModels = Object.values(deps.files.tasks.models)
    .map((m) => m.ollama_model)
    .filter((m): m is string => Boolean(m));

  app.get('/health', async (req, reply) => {
    let modelsPresent: string[] = [];
    const [ollamaOk, speechOk, ttsOk] = await Promise.all([
      probe(async (s) => {
        const r = await deps.ollama.ping(s);
        modelsPresent = r.models;
        return r.ok;
      }),
      probe((s) => deps.speech.ping(s)),
      probe((s) => deps.tts.ping(s)),
    ]);
    const missingModels = ollamaModels.filter((m) => !modelsPresent.some((p) => p === m || p === `${m}:latest`));
    const host = hostStats();
    const p95 = deps.metrics.replyP95Ms();
    const alerts: string[] = [];
    if (host.memUsedPct > 85) alerts.push('host_ram_above_85pct');
    if (p95 !== null && deps.metrics.replySamples() >= 20 && p95 > 20_000) alerts.push('reply_p95_above_20s');
    if (!ollamaOk) alerts.push('ollama_down');
    else if (missingModels.length) alerts.push('model_not_pulled');
    if (!speechOk) alerts.push('speech_down');
    if (!ttsOk) alerts.push('tts_down');

    // `ok` = the core chat path works. Speech/TTS problems show as alerts (degraded).
    const ok = ollamaOk && missingModels.length === 0;
    const status = ok ? (alerts.length ? 'degraded' : 'ok') : 'down';
    reply.code(ok ? 200 : 503);
    return {
      ok,
      status,
      stage: 0,
      alerts,
      services: { ollama: ollamaOk, speech: speechOk, tts: ttsOk },
      models_missing: missingModels,
      queues: Object.values(deps.pools).map((p) => p.stats()),
      reply_p95_ms: p95,
      host,
      uptime_s: Math.round(process.uptime()),
      request_id: req.ctx.requestId,
    };
  });

  app.get('/metrics', async (_req, reply) => {
    reply.type(deps.metrics.registry.contentType);
    return deps.metrics.registry.metrics();
  });
}
