import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';

export function registerModels(app: FastifyInstance, deps: Deps): void {
  app.get('/v1/models', async () => {
    const { models, tasks } = deps.files.tasks;
    return {
      object: 'list',
      data: Object.entries(models).map(([id, m]) => ({
        id,
        object: 'model',
        owned_by: 'koneqti',
        backend: m.backend,
        licence: m.licence ?? null,
        tasks: Object.entries(tasks)
          .filter(([, t]) => t.model === id)
          .map(([name, t]) => ({ name, priority: t.priority, timeout_ms: t.timeout_ms ?? deps.files.limits.defaults.timeout_ms[t.priority] })),
      })),
      tts_languages: Object.entries(deps.files.tts.languages)
        .filter(([, l]) => l.enabled)
        .map(([code, l]) => ({ language: code, voice: l.voice, mode: l.mode })),
    };
  });
}

const UsageQuery = z.object({
  since_hours: z.coerce.number().positive().max(24 * 90).default(24),
  tenant: z.string().max(128).optional(),
});

/** A product can read aggregated usage for its own tenants only. */
export function registerUsage(app: FastifyInstance, deps: Deps): void {
  app.get('/v1/usage', async (req) => {
    const q = UsageQuery.parse(req.query);
    const product = req.ctx.product!;
    const since = Date.now() - q.since_hours * 3_600_000;
    return { product, since: new Date(since).toISOString(), rows: deps.usage.summary(product, since, q.tenant) };
  });
}
