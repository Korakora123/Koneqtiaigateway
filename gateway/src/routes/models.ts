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

const DAY = 86_400_000;
const dateOrTs = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/, 'expected YYYY-MM-DD or ISO time')
  .transform((v) => Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v));

const UsageQuery = z.object({
  subtenant: z.string().max(128).optional(),
  /** Inclusive start date (UTC). Default: 30 days ago. */
  from: dateOrTs.optional(),
  /** Inclusive end date (UTC; a plain date counts the whole day). Default: now. */
  to: z.string().optional(),
  /** Legacy (v0): last N hours. */
  since_hours: z.coerce.number().positive().max(24 * 400).optional(),
});

/**
 * Usage per business (handover §1.5): `GET /v1/usage?subtenant=<id>&from=2026-11-01&to=2026-11-30`.
 * Only the calling tenant's own rows; `subtenant` omitted → totals for the whole tenant.
 */
export function registerUsage(app: FastifyInstance, deps: Deps): void {
  app.get('/v1/usage', async (req) => {
    const q = UsageQuery.parse(req.query);
    const product = req.ctx.product!;
    const now = Date.now();
    let to = now;
    if (q.to) {
      const t = dateOrTs.parse(q.to);
      to = q.to.length === 10 ? t + DAY : t; // whole end day
    }
    const from = q.from ?? (q.since_hours ? now - q.since_hours * 3_600_000 : to - 30 * DAY);
    const subtenant = q.subtenant ?? req.ctx.subtenant ?? undefined;
    const rows = deps.usage.byTask(product, from, to, subtenant);
    const by_task = Object.fromEntries(
      Object.entries(rows).map(([task, r]) => [
        task,
        {
          calls: r.calls,
          ...(r.tokens ? { tokens: r.tokens, tokens_in: r.tokens_in, tokens_out: r.tokens_out } : {}),
          ...(r.audio_sec ? { audio_sec: r.audio_sec } : {}),
          ...(r.chars ? { chars: r.chars } : {}),
          errors: r.errors,
          busy: r.busy,
          avg_latency_ms: r.avg_latency_ms,
        },
      ]),
    );
    return {
      tenant: product,
      subtenant: subtenant ?? null,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      by_task,
    };
  });
}
