import { loadEnv } from './config/env.js';
import { buildApp } from './app.js';

const env = loadEnv();
const { app, deps } = await buildApp({ env });

const host = env.GATEWAY_LISTEN_HOST ?? env.GATEWAY_BIND;
await app.listen({ port: env.GATEWAY_PORT, host });
app.log.info(
  {
    products: deps.keys.size,
    tasks: Object.keys(deps.files.tasks.tasks).length,
    llm_slots: deps.pools.llm.stats().slots,
    offpeak: env.OFFPEAK_WINDOW,
  },
  'koneqti-ai-gateway ready',
);
if (deps.keys.size === 0) app.log.warn('PRODUCT_KEYS is empty — every /v1 request will be rejected');

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    app.log.info({ sig }, 'shutting down');
    app
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
}
