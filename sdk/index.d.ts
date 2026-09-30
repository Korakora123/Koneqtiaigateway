export type Priority = 'realtime' | 'interactive' | 'batch';

export interface CallOptions {
  tenant: string;
  priority?: Priority;
  maxLatencyMs?: number;
  busyRetries?: number;
  signal?: AbortSignal;
}

export interface Meta {
  requestId: string | null;
  modelUsed: string | null;
  queueMs: number;
  usage: string | null;
}

export declare class GatewayError extends Error {
  status: number;
  code: string;
  retryAfterSec?: number;
  requestId?: string;
}
export declare class BusyError extends GatewayError {}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
export interface ChatBody {
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  response_format?: { type: 'text' } | { type: 'json_object' } | { type: 'json_schema'; json_schema: { name?: string; schema: object } };
}

export declare class KoneqtiAI {
  constructor(o?: { url?: string; key?: string; busyRetries?: number; maxRetryWaitMs?: number; fetch?: typeof fetch });
  chat(task: string, body: ChatBody, opts: CallOptions): Promise<{ text: string; json?: unknown; response: unknown; meta: Meta }>;
  chatStream(task: string, body: ChatBody, opts: CallOptions): AsyncGenerator<string>;
  classifySafety(text: string, opts: CallOptions & { language?: string }): Promise<{ category: string; score: number; model: string; meta: Meta }>;
  transcribe(
    audio: Uint8Array | Blob,
    opts: CallOptions & { language?: string; filename?: string },
  ): Promise<{ text: string; language: string; language_probability: number; confidence: number; duration: number; meta: Meta }>;
  speech(text: string, opts: CallOptions & { language: string; format?: 'wav' | 'mp3' | 'ogg' | 'opus' }): Promise<{ audio: Buffer; contentType: string | null; meta: Meta }>;
}
