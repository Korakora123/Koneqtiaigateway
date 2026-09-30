# koneqti-ai-gateway

The private, local-only AI layer for every Koneqti product (MesgAI, KoneqtiSEO, Koneqti Leads,
Tokofy, e-invoice, BlogBot, PinForge). Local models only: no external AI APIs.

- Spec: [`KONEQTI_AI_GATEWAY.md`](KONEQTI_AI_GATEWAY.md) · Rules: [`CLAUDE.md`](CLAUDE.md)
- State, tests, benchmarks, gaps: [`STATUS.md`](STATUS.md)
- Deploying to the VPS: [`DEPLOY.md`](DEPLOY.md)

```
Windows VPS (brains) ──nginx allowlist / CF tunnel──► gateway :8787 (127.0.0.1 only)
                                                        ├─ ollama   qwen3:4b (Q4)       ┐ internal
                                                        ├─ speech   faster-whisper small ├ network,
                                                        └─ tts      Piper                ┘ no internet
      whole stack: 3.5 CPU · 6 GB · oom_score_adj 800 · nice 10
```

## Calling it (from a product)
```bash
curl https://ai.example.com:8443/v1/chat/completions \
  -H "Authorization: Bearer $AI_GATEWAY_KEY" -H "X-Tenant-Id: biz-123" -H "X-Task: reply" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"system","content":"<product prompt + facts>"},{"role":"user","content":"Kal plumber aa sakta hai?"}],"max_tokens":200}'
```
Or with the SDK (`sdk/`, `@koneqti/ai`):
```js
import { KoneqtiAI, BusyError } from '@koneqti/ai';
const ai = new KoneqtiAI(); // AI_GATEWAY_URL, AI_GATEWAY_KEY
try {
  const { text } = await ai.chat('reply', { messages }, { tenant: businessId });
} catch (e) {
  if (e instanceof BusyError) sendHoldingReply(); // product-owned fallback
}
```
Tasks and their model/priority/timeout live in `config/tasks.yaml` — changing a model needs no
product code change (run `evals/` + `bench/` first).

## Layout
```
gateway/            Fastify app — routes, auth, queue, routing, usage (SQLite), metrics
services/speech/    faster-whisper HTTP service
services/tts/       Piper HTTP service (+ Urdu→Devanagari transliteration)
services/voice-clone/  Chatterbox — disabled until Stage 2 (GPU)
config/             tasks.yaml, limits.yaml, tts_languages.yaml, safety.yaml
sdk/                @koneqti/ai thin client
evals/              anonymised eval sets + runner
bench/              eval rate → capacity, load test
ops/                nginx file, systemd slice, cloudflared example
scripts/            limit / egress / memory-pressure / site checks
```

## Develop
```bash
npm --prefix gateway ci && npm --prefix gateway test && npm --prefix gateway run typecheck
pip install -r services/speech/requirements-dev.txt && pytest services/speech
pip install -r services/tts/requirements-dev.txt && pytest services/tts
npm --prefix sdk test && npm --prefix evals test
docker compose up -d --build        # needs models: see DEPLOY.md §5
```
