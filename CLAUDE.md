# CLAUDE.md — koneqti-ai-gateway

You are working in **koneqti-ai-gateway**: the private, local-only AI layer for all
Koneqti products (MesgAI, KoneqtiSEO, Koneqti Leads, Tokofy, e-invoice app/site,
BlogBot, PinForge). Full spec: `KONEQTI_AI_GATEWAY.md`. Scaling rules:
`KONEQTI_SCALING_PLAN.md`.

## 1. Golden rules (never break)
1. **Local models only.** Never add calls to external AI APIs (Claude, OpenAI,
   DeepSeek, Gemini, Groq, OpenRouter, etc.). No API keys for them anywhere.
2. **Stage 0 runs on a shared production server** (Linux, 6 vCPU, 12 GB, CloudPanel
   with live WordPress sites):
   - Never modify CloudPanel, MySQL, PHP-FPM, existing site files or existing nginx
     configs.
   - nginx: **new file only**, always run `nginx -t` before `systemctl reload nginx`.
     Never restart nginx or MySQL.
   - All AI services run in Docker with hard limits (`cpus: 3.5`, `mem_limit: 6g`
     total), `oom_score_adj: 800`, low CPU priority. Never remove or raise these
     limits without the owner's written approval.
   - Don't install system-wide packages or upgrade the host OS; everything runs in
     containers.
3. **Private only:** services bind to `127.0.0.1` / Docker network. Public access only
   through the approved tunnel/nginx file with IP allowlist + product keys.
4. **No message content in logs** (prompts, replies, transcripts, audio). Log only
   metadata.
5. **Gateway has no business logic:** no prompts, business facts or safety decisions.
   Products own those.
6. Ask the owner before any destructive action (deleting data, volumes, models,
   configs) or anything affecting the live sites.

## 2. Stack
- Gateway: Node 20+, TypeScript (strict), Fastify, zod validation, SQLite (usage, Stage 0).
- Models: Ollama (Qwen3-4B Q4, `enable_thinking: false`) — Stage 0.
- Speech: Python, faster-whisper `small` int8 (2 threads).
- TTS: Piper (check each voice licence before adding).
- Voice cloning: `services/voice-clone/` (Chatterbox, moved from
  `mesgai-brain/voice-engine/`) — **disabled** until Stage 2 (GPU).
- Tests: vitest (gateway), pytest (speech). Load/bench scripts in `bench/`.

## 3. Repo layout
```
gateway/            Fastify app (routes, auth, queue, routing, usage, metrics)
  src/routes/       chat.ts, transcriptions.ts, speech.ts, voices.ts, safety.ts, health.ts
  src/queue/        priority queue (realtime > interactive > batch), 503 busy handling
  src/config/       loads config/*.yaml, env
services/speech/    faster-whisper HTTP service
services/tts/       Piper HTTP service + voice files
services/voice-clone/  Chatterbox (disabled)
config/             tasks.yaml, tts_languages.yaml, keys (via env), limits.yaml
evals/              anonymised test sets + runner
bench/              benchmark scripts (eval rate → capacity)
docker-compose.yml  with resource limits
STATUS.md           current state, benchmarks, known gaps
```

## 4. Environment variables
`GATEWAY_PORT`, `GATEWAY_BIND=127.0.0.1`, `PRODUCT_KEYS` (JSON map product→key hash),
`ALLOWED_IPS`, `OLLAMA_URL`, `SPEECH_URL`, `TTS_URL`, `OFFPEAK_WINDOW`
(e.g. `01:00-07:00`), `MAX_CONTEXT_TOKENS=4096`, `LOG_LEVEL`.
Ollama: `OLLAMA_NUM_PARALLEL=2`, `OLLAMA_MAX_LOADED_MODELS=1`,
`OLLAMA_KEEP_ALIVE=10m`, `OLLAMA_MAX_QUEUE=64`.
Never commit secrets; `.env.example` only.

## 5. How to add or change a task/model
1. Edit `config/tasks.yaml` (model, priority, timeout, max_tokens, json_schema).
2. Run `evals/` for affected languages; model switch only if equal or better.
3. Run `bench/` and record results in STATUS.md.
4. No product code change should be needed.

## 6. Behaviour rules
- Priority: realtime > interactive > batch. Batch only in off-peak window or when
  realtime queue is empty.
- If a request can't meet its timeout → `503 busy` + `Retry-After`. Never drop silently.
- Unsupported TTS language → `422 tts_language_unavailable`.
- Voices endpoints → `501 not_available_until_gpu` in Stage 0.
- Every response sets `X-Model-Used`, `X-Queue-Ms`, `X-Usage`, `X-Request-Id`.

## 7. Definition of done (every task)
- Types pass, tests pass, `docker compose up` works with limits in place.
- Acceptance tests in the spec for that part pass.
- Spot-check that CloudPanel sites still respond normally under AI load.
- STATUS.md updated: what changed, env vars, benchmarks, owner manual steps, known gaps.

## 8. Commands
```
docker compose up -d --build          # start stack (limits applied)
docker stats                          # verify CPU/RAM limits under load
npm --prefix gateway test             # gateway tests
pytest services/speech                # speech tests
node bench/run.js                     # benchmark → capacity estimate
npm --prefix evals run eval           # model evals
```
