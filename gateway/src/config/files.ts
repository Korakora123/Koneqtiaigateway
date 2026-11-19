import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

export const PRIORITIES = ['realtime', 'normal', 'batch'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PriorityEnum = z.enum(PRIORITIES);

export const POOLS = ['llm', 'speech', 'tts'] as const;
export type PoolName = (typeof POOLS)[number];

const ModelSchema = z.object({
  backend: z.enum(['ollama', 'speech', 'tts']),
  ollama_model: z.string().optional(),
  think: z.boolean().optional(),
  num_thread: z.number().int().positive().optional(),
  licence: z.string().optional(),
});

const TaskSchema = z.object({
  model: z.string(),
  service: z.enum(['llm', 'speech', 'tts']).default('llm'),
  priority: PriorityEnum.default('normal'),
  /** Jumps ahead of other `normal` jobs (short classify calls). */
  fast: z.boolean().default(false),
  timeout_ms: z.number().int().positive().optional(),
  max_tokens: z.number().int().positive().optional(),
  json_schema: z.boolean().default(false),
  /** Default temperature when the caller sends none (routing parameter, not a prompt). */
  temperature: z.number().min(0).max(2).optional(),
  /** > 0 → identical requests (temperature ≤ 0.3) are answered from the per-business cache for this long. */
  cache_ttl_s: z.number().int().nonnegative().default(0),
  languages: z.string().optional(),
});

const TasksFileSchema = z
  .object({
    models: z.record(z.string(), ModelSchema),
    tasks: z.record(z.string(), TaskSchema),
  })
  .superRefine((f, ctx) => {
    for (const [name, t] of Object.entries(f.tasks)) {
      if (!f.models[t.model]) ctx.addIssue({ code: 'custom', message: `task ${name}: unknown model ${t.model}` });
    }
  });

const perPriority = <T extends z.ZodTypeAny>(s: T) => z.object({ realtime: s, normal: s, batch: s });
const RateSchema = z.object({ requests_per_min: z.number().int().positive(), concurrent: z.number().int().positive() });
const PoolSchema = z.object({
  slots: z.number().int().positive(),
  reserved_realtime: z.number().int().nonnegative().default(0),
  max_queue: z.object({ normal: z.number().int().nonnegative(), batch: z.number().int().nonnegative() }),
});

const LimitsFileSchema = z.object({
  pools: z.object({ llm: PoolSchema, speech: PoolSchema, tts: PoolSchema }),
  defaults: z.object({
    timeout_ms: perPriority(z.number().int().positive()),
    initial_service_ms: z.object({ llm: z.number().positive(), speech: z.number().positive(), tts: z.number().positive() }),
  }),
  batch: z.object({ peak_max_concurrent: z.number().int().min(0) }),
  rate_limits: z.object({
    default_tenant: RateSchema,
    default_subtenant: RateSchema,
    tenants: z.record(z.string(), RateSchema).nullish().transform((v) => v ?? {}),
    subtenants: z.record(z.string(), RateSchema).nullish().transform((v) => v ?? {}),
  }),
  request: z.object({
    max_body_bytes: z.number().int().positive(),
    max_audio_bytes: z.number().int().positive(),
    max_tts_chars: z.number().int().positive(),
    max_safety_chars: z.number().int().positive().default(1000),
  }),
});

const TtsLanguageSchema = z.object({
  voice: z.string(),
  mode: z.enum(['native', 'transliterate']).default('native'),
  transliterate: z.string().optional(),
  enabled: z.boolean().default(true),
  licence_checked: z.boolean().default(false),
});

const TtsFileSchema = z.object({
  voice_base_url: z.string().optional(),
  languages: z.record(z.string(), TtsLanguageSchema),
});

const SafetyFileSchema = z.object({
  categories: z.array(z.string()).min(2),
  system_prompt: z.string().min(1),
});

export type ModelConfig = z.infer<typeof ModelSchema>;
export type TaskConfig = z.infer<typeof TaskSchema>;
export type TasksFile = z.infer<typeof TasksFileSchema>;
export type LimitsFile = z.infer<typeof LimitsFileSchema>;
export type TtsFile = z.infer<typeof TtsFileSchema>;
export type SafetyFile = z.infer<typeof SafetyFileSchema>;
export type RateLimit = z.infer<typeof RateSchema>;

export interface FileConfig {
  tasks: TasksFile;
  limits: LimitsFile;
  tts: TtsFile;
  safety: SafetyFile;
}

function loadYaml<T>(dir: string, file: string, schema: z.ZodType<T>): T {
  const path = join(dir, file);
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read ${path}: ${(err as Error).message}`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid ${file}: ${msg}`);
  }
  return parsed.data;
}

export function loadFileConfig(dir: string): FileConfig {
  return {
    tasks: loadYaml(dir, 'tasks.yaml', TasksFileSchema),
    limits: loadYaml(dir, 'limits.yaml', LimitsFileSchema),
    tts: loadYaml(dir, 'tts_languages.yaml', TtsFileSchema),
    safety: loadYaml(dir, 'safety.yaml', SafetyFileSchema),
  };
}

/** Task budget at the given priority. Realtime is always capped at the live-call turn budget. */
export function timeoutFor(task: TaskConfig, priority: Priority, limits: LimitsFile): number {
  const t = task.timeout_ms ?? limits.defaults.timeout_ms[priority];
  return priority === 'realtime' ? Math.min(t, limits.defaults.timeout_ms.realtime) : t;
}
