import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../src/config/env.js';
import { loadFileConfig } from '../src/config/files.js';
import { buildApp } from '../src/app.js';
import { sha256Hex } from '../src/auth.js';

export const CONFIG_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'config');
export const KEY = 'test-key-mesgai-0123456789';
export const KEY2 = 'test-key-tokofy-0123456789';

export type Handler = (req: IncomingMessage, body: Buffer, res: ServerResponse) => void | Promise<void>;

/** Minimal fake backend (Ollama / speech / tts) with a swappable handler and request log. */
export class FakeBackend {
  handler: Handler = (_req, _b, res) => {
    res.writeHead(404).end();
  };
  readonly requests: Array<{ url: string; body: Buffer; headers: IncomingMessage['headers'] }> = [];
  private server: Server;
  url = '';

  constructor() {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        this.requests.push({ url: req.url ?? '', body, headers: req.headers });
        void this.handler(req, body, res);
      });
    });
  }

  async start(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  lastJson<T = Record<string, unknown>>(): T {
    return JSON.parse(this.requests.at(-1)!.body.toString('utf8')) as T;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

export function json(res: ServerResponse, status: number, obj: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(obj));
}

/** Ollama-like /api/chat reply (non-streaming or NDJSON streaming) with an optional delay. */
export function ollamaReply(content: string, opts: { delayMs?: number; promptTokens?: number; evalTokens?: number } = {}): Handler {
  return async (req, body, res) => {
    if (req.url === '/api/tags') return json(res, 200, { models: [{ name: 'qwen3:4b' }] });
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (res.destroyed) return;
    const reqBody = JSON.parse(body.toString('utf8')) as { stream: boolean };
    const final = {
      done: true,
      done_reason: 'stop',
      prompt_eval_count: opts.promptTokens ?? 42,
      eval_count: opts.evalTokens ?? 17,
    };
    if (!reqBody.stream) return json(res, 200, { message: { role: 'assistant', content }, ...final });
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    const pieces = content.match(/.{1,5}/gs) ?? [];
    for (const p of pieces) res.write(JSON.stringify({ message: { role: 'assistant', content: p }, done: false }) + '\n');
    res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, ...final }) + '\n');
  };
}

export class LogCapture extends Writable {
  lines: string[] = [];
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void): void {
    this.lines.push(chunk.toString('utf8'));
    cb();
  }
  get text(): string {
    return this.lines.join('');
  }
}

export interface Harness {
  app: Awaited<ReturnType<typeof buildApp>>['app'];
  deps: Awaited<ReturnType<typeof buildApp>>['deps'];
  ollama: FakeBackend;
  speech: FakeBackend;
  tts: FakeBackend;
  logs: LogCapture;
  close: () => Promise<void>;
}

export async function harness(envOver: Record<string, string> = {}, now?: () => Date): Promise<Harness> {
  const [ollama, speech, tts] = await Promise.all([new FakeBackend().start(), new FakeBackend().start(), new FakeBackend().start()]);
  ollama.handler = ollamaReply('ok');
  speech.handler = (req, _b, res) => (req.url === '/health' ? json(res, 200, { ok: true }) : json(res, 404, {}));
  tts.handler = (req, _b, res) => (req.url === '/health' ? json(res, 200, { ok: true }) : json(res, 404, {}));
  const env = loadEnv({
    PRODUCT_KEYS: JSON.stringify({ mesgai: sha256Hex(KEY), tokofy: sha256Hex(KEY2) }),
    ALLOWED_IPS: '127.0.0.1',
    OLLAMA_URL: ollama.url,
    SPEECH_URL: speech.url,
    TTS_URL: tts.url,
    CONFIG_DIR,
    USAGE_DB_PATH: ':memory:',
    LOG_LEVEL: 'info',
    OFFPEAK_WINDOW: '01:00-07:00',
    ...envOver,
  });
  const logs = new LogCapture();
  const { app, deps } = await buildApp({ env, files: loadFileConfig(CONFIG_DIR), logStream: logs, ...(now ? { now } : {}) });
  await app.ready();
  return {
    app,
    deps,
    ollama,
    speech,
    tts,
    logs,
    close: async () => {
      await app.close();
      await Promise.all([ollama.stop(), speech.stop(), tts.stop()]);
    },
  };
}

export const authHeaders = (task?: string, extra: Record<string, string> = {}): Record<string, string> => ({
  authorization: `Bearer ${KEY}`,
  'x-tenant-id': 'biz-001',
  ...(task ? { 'x-task': task } : {}),
  ...extra,
});
