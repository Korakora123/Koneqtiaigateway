import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { resolveTask } from '../context.js';
import { prepareChat, runChat } from './chat.js';

const SafetyBody = z.object({
  text: z.string().min(1).max(4000),
  language: z.string().max(16).optional(),
});

/**
 * Returns {category, score} only. What to do with it (emergency script, keyword filter,
 * thresholds, what happens on 503) is decided by the calling product.
 */
export function registerSafety(app: FastifyInstance, deps: Deps): void {
  const { categories, system_prompt } = deps.files.safety;
  const schema = {
    type: 'object',
    properties: {
      category: { type: 'string', enum: categories },
      score: { type: 'number', minimum: 0, maximum: 1 },
    },
    required: ['category', 'score'],
    additionalProperties: false,
  };

  app.post('/v1/safety/classify', async (req, reply) => {
    const body = SafetyBody.parse(req.body);
    const task = resolveTask(req, deps, { fixedTask: 'classify.safety', service: 'llm' });
    const userText = body.language ? `[language: ${body.language}]\n${body.text}` : body.text;
    const prepared = prepareChat(
      {
        messages: [
          { role: 'system', content: system_prompt },
          { role: 'user', content: userText },
        ],
        stream: false,
        temperature: 0,
        response_format: { type: 'json_schema', json_schema: { name: 'safety', schema } },
      },
      task,
      deps,
    );
    // Small JSON object: allow enough tokens even if the task cap is tiny.
    prepared.ollama.options.num_predict = Math.max(prepared.ollama.options.num_predict ?? 0, 40);
    const out = await runChat(req, deps, task, prepared);
    const parsed = JSON.parse(out.content) as { category: string; score: number };
    return reply.send({ category: parsed.category, score: Math.round(parsed.score * 1000) / 1000, model: task.cfg.model });
  });
}
