import { z } from 'zod';

const jsonRecord = z.string().transform((raw, ctx) => {
  try {
    const parsed: unknown = JSON.parse(raw);
    const rec = z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/i, 'expected sha256 hex')).parse(parsed);
    return rec;
  } catch (err) {
    ctx.addIssue({ code: 'custom', message: `PRODUCT_KEYS must be a JSON map product→sha256(key) hex: ${(err as Error).message}` });
    return z.NEVER;
  }
});

const csv = z
  .string()
  .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean));

const EnvSchema = z.object({
  GATEWAY_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  GATEWAY_BIND: z.string().default('127.0.0.1'),
  /** Address the process listens on. In Docker this is 0.0.0.0 while the *published* port stays on GATEWAY_BIND. */
  GATEWAY_LISTEN_HOST: z.string().optional(),
  PRODUCT_KEYS: jsonRecord.default({}),
  ALLOWED_IPS: csv.default(['127.0.0.1', '::1']),
  /** Proxies whose X-Forwarded-For is trusted (nginx / docker-proxy on the host). */
  TRUST_PROXY: csv.default(['127.0.0.1', '::1']),
  OLLAMA_URL: z.string().url().default('http://127.0.0.1:11434'),
  SPEECH_URL: z.string().url().default('http://127.0.0.1:9001'),
  TTS_URL: z.string().url().default('http://127.0.0.1:9002'),
  OFFPEAK_WINDOW: z
    .string()
    .regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/, 'expected HH:MM-HH:MM')
    .default('01:00-07:00'),
  MAX_CONTEXT_TOKENS: z.coerce.number().int().min(256).default(4096),
  OLLAMA_NUM_PARALLEL: z.coerce.number().int().min(1).optional(),
  OLLAMA_KEEP_ALIVE: z.string().default('10m'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CONFIG_DIR: z.string().default('../config'),
  USAGE_DB_PATH: z.string().default('./usage.db'),
  USAGE_RETENTION_DAYS: z.coerce.number().int().positive().default(180),
  /** Voices endpoints / voice cloning. Stage 0 = false → 501 not_available_until_gpu. */
  VOICE_CLONE_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) if (v !== undefined && v !== '') cleaned[k] = v;
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${msg}`);
  }
  return parsed.data;
}
