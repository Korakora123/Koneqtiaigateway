import { GatewayError } from '../errors.js';

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  stream: boolean;
  think?: boolean;
  format?: 'json' | Record<string, unknown>;
  keep_alive?: string;
  options: {
    num_ctx: number;
    num_predict?: number;
    num_thread?: number;
    temperature?: number;
    top_p?: number;
    seed?: number;
    stop?: string[];
  };
}

export interface OllamaChatChunk {
  message?: { role: string; content: string; thinking?: string };
  done: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  eval_duration?: number;
  error?: string;
}

export interface OllamaResult {
  content: string;
  doneReason: string;
  tokensIn: number;
  tokensOut: number;
}

/** Removes a leading Qwen3 `<think>…</think>` block if the runtime still emits one. */
export function stripThink(text: string): string {
  return text.replace(/^\s*<think>[\s\S]*?<\/think>\s*/, '');
}

/**
 * Streaming variant of stripThink: holds back output while it may still be inside a
 * leading <think> block, then passes everything else through untouched.
 */
export class ThinkFilter {
  private buf = '';
  private passthrough = false;
  /** Just closed a think block: drop whitespace until the first real character. */
  private trimNext = false;

  push(chunk: string): string {
    if (this.passthrough) {
      if (!this.trimNext) return chunk;
      const t = chunk.trimStart();
      if (t) this.trimNext = false;
      return t;
    }
    this.buf += chunk;
    const trimmed = this.buf.trimStart();
    if (trimmed.length === 0) return '';
    if ('<think>'.startsWith(trimmed.slice(0, 7)) && trimmed.length < 7) return '';
    if (!trimmed.startsWith('<think>')) {
      this.passthrough = true;
      const out = this.buf;
      this.buf = '';
      return out;
    }
    const end = trimmed.indexOf('</think>');
    if (end < 0) return '';
    this.passthrough = true;
    const rest = trimmed.slice(end + '</think>'.length).trimStart();
    this.trimNext = rest.length === 0;
    this.buf = '';
    return rest;
  }

  flush(): string {
    if (this.passthrough) return '';
    const out = this.buf.trimStart().startsWith('<think>') ? '' : this.buf;
    this.buf = '';
    return out;
  }
}

export class OllamaClient {
  constructor(private readonly baseUrl: string) {}

  private async post(req: OllamaChatRequest, signal: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new GatewayError(502, 'backend_unavailable', 'model backend unreachable');
    }
    if (!res.ok) {
      // Ollama answers 503 when its own queue (OLLAMA_MAX_QUEUE) is full.
      if (res.status === 503) throw new GatewayError(503, 'busy', 'model backend queue full', 5);
      const body = await res.text().catch(() => '');
      const notFound = res.status === 404 || /not found/i.test(body);
      throw new GatewayError(
        502,
        notFound ? 'model_not_loaded' : 'backend_error',
        notFound ? 'model not pulled on backend (run setup profile)' : `model backend error (${res.status})`,
      );
    }
    return res;
  }

  async chat(req: OllamaChatRequest, signal: AbortSignal): Promise<OllamaResult> {
    const res = await this.post({ ...req, stream: false }, signal);
    const data = (await res.json()) as OllamaChatChunk;
    if (data.error) throw new GatewayError(502, 'backend_error', 'model backend error');
    return {
      content: stripThink(data.message?.content ?? ''),
      doneReason: data.done_reason ?? 'stop',
      tokensIn: data.prompt_eval_count ?? 0,
      tokensOut: data.eval_count ?? 0,
    };
  }

  /** Yields parsed NDJSON chunks from a streaming /api/chat call. */
  async *chatStream(req: OllamaChatRequest, signal: AbortSignal): AsyncGenerator<OllamaChatChunk> {
    const res = await this.post({ ...req, stream: true }, signal);
    if (!res.body) throw new GatewayError(502, 'backend_error', 'empty stream from model backend');
    const decoder = new TextDecoder();
    let buf = '';
    for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(part, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const chunk = JSON.parse(line) as OllamaChatChunk;
        if (chunk.error) throw new GatewayError(502, 'backend_error', 'model backend error');
        yield chunk;
      }
    }
    const tail = buf.trim();
    if (tail) yield JSON.parse(tail) as OllamaChatChunk;
  }

  async ping(signal: AbortSignal): Promise<{ ok: boolean; models: string[] }> {
    const res = await fetch(`${this.baseUrl}/api/tags`, { signal });
    if (!res.ok) return { ok: false, models: [] };
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    return { ok: true, models: (data.models ?? []).map((m) => m.name) };
  }
}
