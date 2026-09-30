import type { Env } from './config/env.js';
import type { FileConfig } from './config/files.js';
import type { KeyStore, IpAllowList } from './auth.js';
import type { RateLimiter } from './ratelimit.js';
import type { PriorityPool } from './queue/pool.js';
import type { UsageStore } from './usage.js';
import type { Metrics } from './metrics.js';
import type { OllamaClient } from './backends/ollama.js';
import type { SpeechClient, TtsClient } from './backends/audio.js';

export interface Deps {
  env: Env;
  files: FileConfig;
  keys: KeyStore;
  allowList: IpAllowList;
  rateLimiter: RateLimiter;
  pools: { llm: PriorityPool; speech: PriorityPool; tts: PriorityPool };
  usage: UsageStore;
  metrics: Metrics;
  ollama: OllamaClient;
  speech: SpeechClient;
  tts: TtsClient;
}
