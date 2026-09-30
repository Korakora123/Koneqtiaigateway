import type { FastifyInstance } from 'fastify';
import type { Deps } from '../deps.js';
import { GatewayError } from '../errors.js';

/** Voice cloning (Chatterbox) arrives with Stage 2 (GPU) — with consent record and working delete. */
export function registerVoices(app: FastifyInstance, deps: Deps): void {
  const handler = async (): Promise<never> => {
    if (!deps.env.VOICE_CLONE_ENABLED) {
      throw new GatewayError(501, 'not_available_until_gpu', 'voice cloning is available from Stage 2 (GPU)');
    }
    throw new GatewayError(501, 'not_implemented', 'voice-clone service is not wired in this build');
  };
  app.put('/v1/voices/:business_id', handler);
  app.get('/v1/voices/:business_id', handler);
  app.delete('/v1/voices/:business_id', handler);
}

export function registerEmbeddings(app: FastifyInstance): void {
  app.post('/v1/embeddings', async () => {
    throw new GatewayError(501, 'not_available_until_later_stage', 'embeddings (BGE-M3) arrive in a later stage');
  });
}
