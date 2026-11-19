import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { GatewayError } from '../errors.js';

const ID_RE = /^[A-Za-z0-9._:@-]{1,128}$/;

const Settings = z
  .object({
    /** Days the gateway may keep message content for this business. 0 (default) = nothing beyond the request. */
    retention_days: z.number().int().min(0).max(3650).default(0),
    /** Whether answers for this business may be cached (cache is always per business). */
    allow_cache: z.boolean().default(true),
  })
  .strict();

function subtenantParam(params: unknown): string {
  const id = (params as { id?: string }).id ?? '';
  if (!ID_RE.test(id)) throw new GatewayError(400, 'invalid_subtenant', 'subtenant id must match [A-Za-z0-9._:@-], max 128');
  return id;
}

/**
 * Per-business privacy controls (master spec §11.1, handover §1.6). A key only ever reaches
 * subtenants of its own tenant: every query is scoped by the key's product.
 *
 * The gateway keeps no prompts, transcripts or audio. It keeps metadata (ledger) and, for
 * cacheable tasks, cached answers. DELETE removes ledger rows, cached answers and settings.
 * `retention_days` is recorded for later features (stored transcripts).
 */
export function registerSubtenants(app: FastifyInstance, deps: Deps): void {
  app.get('/v1/subtenants/:id/settings', async (req) => {
    const id = subtenantParam(req.params);
    const { exists, ...s } = deps.usage.getSettings(req.ctx.product!, id);
    return { subtenant: id, ...s, known: exists };
  });

  app.put('/v1/subtenants/:id/settings', async (req) => {
    const id = subtenantParam(req.params);
    const s = Settings.parse(req.body ?? {});
    deps.usage.putSettings(req.ctx.product!, id, s);
    return { ok: true };
  });

  app.delete('/v1/subtenants/:id/data', async (req) => {
    const id = subtenantParam(req.params);
    const removed = { ...deps.usage.deleteSubtenant(req.ctx.product!, id), cache_entries: deps.cache.deleteSubtenant(req.ctx.product!, id) };
    req.log.info({ product: req.ctx.product, subtenant: id, ...removed }, 'subtenant data deleted');
    return { ok: true, removed: { ...removed, voices: 0 } };
  });
}
