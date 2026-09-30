import { PassThrough } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Ajv } from 'ajv';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { GatewayError } from '../errors.js';
import { acquireSlot, resolveTask, withSlot, type ResolvedTask } from '../context.js';
import { ThinkFilter, type OllamaChatRequest, type OllamaMessage } from '../backends/ollama.js';

const TextPart = z.object({ type: z.literal('text'), text: z.string() });
const OtherPart = z.object({ type: z.string() }).passthrough();

const MessageSchema = z.object({
  role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
  content: z.union([z.string(), z.array(z.union([TextPart, OtherPart]))]).nullable().default(''),
  name: z.string().optional(),
});

const ResponseFormat = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text') }),
  z.object({ type: z.literal('json_object') }),
  z.object({
    type: z.literal('json_schema'),
    json_schema: z.object({
      name: z.string().optional(),
      schema: z.record(z.string(), z.unknown()),
      strict: z.boolean().optional(),
    }),
  }),
]);

export const ChatBody = z.object({
  model: z.string().optional(),
  messages: z.array(MessageSchema).min(1).max(200),
  stream: z.boolean().default(false),
  stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  seed: z.number().int().optional(),
  stop: z.union([z.string(), z.array(z.string()).max(8)]).optional(),
  response_format: ResponseFormat.optional(),
  tools: z.array(z.unknown()).optional(),
  n: z.number().int().optional(),
});
export type ChatBodyT = z.infer<typeof ChatBody>;

const ajv = new Ajv({ strict: false, allErrors: false });

/** Conservative token estimate (~3 chars/token, plus per-message overhead). */
export function estimateTokens(messages: OllamaMessage[]): number {
  return messages.reduce((n, m) => n + Math.ceil(m.content.length / 3) + 4, 0);
}

function toOllamaMessages(body: ChatBodyT): OllamaMessage[] {
  return body.messages.map((m) => {
    let content: string;
    if (typeof m.content === 'string' || m.content === null) content = m.content ?? '';
    else {
      if (m.content.some((p) => p.type !== 'text')) {
        throw new GatewayError(400, 'unsupported_content', 'only text content is supported in Stage 0 (no images/audio parts)');
      }
      content = m.content.map((p) => (p as z.infer<typeof TextPart>).text).join('');
    }
    return { role: m.role === 'developer' ? 'system' : m.role, content };
  });
}

export interface PreparedChat {
  ollama: OllamaChatRequest;
  schema: Record<string, unknown> | null;
  wantsJson: boolean;
}

/** Builds the Ollama request from an OpenAI-style body plus the task's limits. */
export function prepareChat(body: ChatBodyT, task: ResolvedTask, deps: Deps): PreparedChat {
  if (body.tools?.length) throw new GatewayError(400, 'tools_not_supported', 'tool calling is not available in Stage 0');
  if (body.n !== undefined && body.n !== 1) throw new GatewayError(400, 'n_not_supported', 'only n=1 is supported');

  const model = deps.files.tasks.models[task.cfg.model]!;
  if (model.backend !== 'ollama' || !model.ollama_model) {
    throw new GatewayError(500, 'misconfigured_task', `task ${task.name} does not map to an LLM`);
  }

  const rf = body.response_format;
  if (task.cfg.json_schema && rf?.type !== 'json_schema') {
    throw new GatewayError(400, 'json_schema_required', `task ${task.name} requires response_format {type: "json_schema"}`);
  }
  let schema: Record<string, unknown> | null = null;
  let format: OllamaChatRequest['format'];
  if (rf?.type === 'json_schema') {
    schema = rf.json_schema.schema;
    if (!ajv.validateSchema(schema)) throw new GatewayError(400, 'invalid_json_schema', 'response_format.json_schema.schema is not a valid JSON Schema');
    format = schema;
  } else if (rf?.type === 'json_object') format = 'json';

  const messages = toOllamaMessages(body);
  const maxCtx = deps.env.MAX_CONTEXT_TOKENS;
  const requested = body.max_completion_tokens ?? body.max_tokens;
  const cap = task.cfg.max_tokens;
  let numPredict = requested !== undefined && cap !== undefined ? Math.min(requested, cap) : (requested ?? cap);
  const promptEst = estimateTokens(messages);
  if (promptEst >= maxCtx) {
    throw new GatewayError(400, 'context_length_exceeded', `prompt is ~${promptEst} tokens; limit is ${maxCtx} including the reply`);
  }
  if (numPredict !== undefined && promptEst + numPredict > maxCtx) numPredict = Math.max(1, maxCtx - promptEst);
  if (numPredict === undefined) numPredict = Math.max(1, maxCtx - promptEst);

  const stop = typeof body.stop === 'string' ? [body.stop] : body.stop;
  return {
    schema,
    wantsJson: format !== undefined,
    ollama: {
      model: model.ollama_model,
      messages,
      stream: body.stream,
      think: model.think ?? false,
      ...(format !== undefined ? { format } : {}),
      keep_alive: deps.env.OLLAMA_KEEP_ALIVE,
      options: {
        num_ctx: maxCtx,
        num_predict: numPredict,
        ...(model.num_thread ? { num_thread: model.num_thread } : {}),
        ...(body.temperature !== undefined ? { temperature: body.temperature } : format ? { temperature: 0 } : {}),
        ...(body.top_p !== undefined ? { top_p: body.top_p } : {}),
        ...(body.seed !== undefined ? { seed: body.seed } : {}),
        ...(stop ? { stop } : {}),
      },
    },
  };
}

/** Parses and (if a schema was given) validates JSON model output. */
export function checkJsonOutput(content: string, schema: Record<string, unknown> | null): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new GatewayError(502, 'invalid_model_output', 'model did not return valid JSON');
  }
  if (schema && !ajv.validate(schema, parsed)) {
    throw new GatewayError(502, 'schema_validation_failed', 'model output does not match the requested JSON schema');
  }
  return parsed;
}

export interface ChatOutcome {
  content: string;
  finishReason: 'stop' | 'length';
  tokensIn: number;
  tokensOut: number;
}

/** Non-streaming chat through the llm pool. Shared with /v1/safety/classify. */
export async function runChat(req: FastifyRequest, deps: Deps, task: ResolvedTask, prepared: PreparedChat): Promise<ChatOutcome> {
  const out = await withSlot(req, deps, deps.pools.llm, task, (signal) => deps.ollama.chat(prepared.ollama, signal));
  const ctx = req.ctx;
  ctx.tokensIn = out.tokensIn;
  ctx.tokensOut = out.tokensOut;
  ctx.evalMs = out.evalMs;
  if (prepared.wantsJson) checkJsonOutput(out.content, prepared.schema);
  return {
    content: out.content,
    finishReason: out.doneReason === 'length' ? 'length' : 'stop',
    tokensIn: out.tokensIn,
    tokensOut: out.tokensOut,
  };
}

function usageObj(i: number, o: number): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
  return { prompt_tokens: i, completion_tokens: o, total_tokens: i + o };
}

export function registerChat(app: FastifyInstance, deps: Deps): void {
  app.post('/v1/chat/completions', async (req, reply) => {
    const body = ChatBody.parse(req.body);
    const task = resolveTask(req, deps, { service: 'llm' });
    const prepared = prepareChat(body, task, deps);
    const ctx = req.ctx;
    const id = `chatcmpl-${ctx.requestId}`;
    const created = Math.floor(Date.now() / 1000);
    const model = task.cfg.model;

    if (!body.stream) {
      const out = await runChat(req, deps, task, prepared);
      return reply.send({
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: out.content }, finish_reason: out.finishReason }],
        usage: usageObj(out.tokensIn, out.tokensOut),
      });
    }

    // Streaming (SSE, OpenAI chunk format). Slot is held until the stream ends.
    ctx.stream = true;
    const slot = await acquireSlot(req, deps, deps.pools.llm, task);
    const iter = deps.ollama.chatStream(prepared.ollama, slot.signal);
    let first: IteratorResult<Awaited<ReturnType<typeof iter.next>>['value']>;
    try {
      first = await iter.next(); // surface connection errors as normal HTTP errors
    } catch (err) {
      slot.release(false);
      throw slot.mapError(err);
    }

    const out = new PassThrough();
    const sse = (obj: unknown): void => {
      out.write(`data: ${JSON.stringify(obj)}\n\n`);
    };
    const chunk = (delta: Record<string, string>, finish: string | null): void =>
      sse({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] });

    void (async () => {
      const filter = new ThinkFilter();
      let ok = false;
      try {
        chunk({ role: 'assistant', content: '' }, null);
        let res = first;
        while (!res.done) {
          const c = res.value;
          const text = filter.push(c.message?.content ?? '');
          if (text) chunk({ content: text }, null);
          if (c.done) {
            const tail = filter.flush();
            if (tail) chunk({ content: tail }, null);
            ctx.tokensIn = c.prompt_eval_count ?? 0;
            ctx.tokensOut = c.eval_count ?? 0;
            ctx.evalMs = Math.round((c.eval_duration ?? 0) / 1e6);
            chunk({}, c.done_reason === 'length' ? 'length' : 'stop');
            if (body.stream_options?.include_usage) {
              sse({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: usageObj(ctx.tokensIn, ctx.tokensOut) });
            }
          }
          res = await iter.next();
        }
        out.write('data: [DONE]\n\n');
        ok = true;
      } catch (err) {
        const mapped = slot.mapError(err);
        const ge = mapped instanceof GatewayError ? mapped : new GatewayError(502, 'backend_error', 'stream interrupted');
        ctx.errorCode = ge.code;
        if (!ctx.clientAbort.signal.aborted) sse(ge.toBody());
      } finally {
        slot.release(ok);
        out.end();
      }
    })();

    reply
      .header('content-type', 'text/event-stream; charset=utf-8')
      .header('cache-control', 'no-cache')
      .header('x-accel-buffering', 'no')
      .header('x-usage', 'stream');
    return reply.send(out);
  });
}
