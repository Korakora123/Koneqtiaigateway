# KONEQTI_AI_GATEWAY.md — v3: Local-only AI layer for every Koneqti product

Repo: **`koneqti-ai-gateway`**. Replaces v1/v2 and the June "Ai Gateway" design.
Serves: MesgAI, KoneqtiSEO, Koneqti Leads, Tokofy, e-invoice site/app, BlogBot,
PinForge, Suite. Companion: `CLAUDE.md` (rules for Claude Code in this repo),
`KONEQTI_SCALING_PLAN.md`.

---

## 0. Decisions
1. **Local models only. No paid external AI APIs** (no Claude, OpenAI, DeepSeek…).
2. **CPU now, GPU later.** Same API for products at every stage; only gateway config
   and hardware change.
3. **Stage 0 runs on the existing Linux VPS** (6 vCPU, 12 GB RAM, CloudPanel with
   live sites) **with hard resource limits** so websites are never affected.
4. Gateway = capability layer only. **Prompts, business facts and safety decisions
   stay in each product** (e.g. MesgAI keeps keyword filter, emergency scripts,
   facts-only checks).
5. Private only: called server-to-server by Koneqti products. Never from phones,
   browsers or user PCs.

---

## 1. Stages
| Stage | Hardware | Models | Features |
|---|---|---|---|
| **0 — now** | Existing Linux VPS: 6 vCPU, 12 GB (gateway capped at ~3.5 CPU, 6 GB RAM) | Qwen3-4B (Q4) for all text tasks · faster-whisper **small** (int8) · Piper | Chat replies, voice notes → text, safety score, extraction, batch jobs at night. **No live AI phone calls. No voice cloning.** |
| 1 — own CPU server | Linux VPS 16–24 GB, 8–12 dedicated vCPU | + Qwen3-1.7B (fast classify) · Qwen3-8B on demand (batch quality) · Whisper medium for hard Urdu/Arabic | More businesses, better batch quality |
| 2 — GPU | Linux GPU: 24 GB VRAM, 64 GB RAM | Qwen3-8B on **vLLM** · Whisper large-v3-turbo · **Chatterbox** voice cloning · Silero VAD | Live AI phone calls, voice replies, many concurrent chats |
| 3 — scale | 48–80 GB GPU or 2+ GPU servers | Qwen3-14B / 30B-A3B, split chat vs speech | Hundreds of businesses |

---

## 2. Architecture (Stage 0)
```
Windows VPS (brains/workers) ──(Cloudflare tunnel or firewall: only its IP)──►
  Linux VPS (CloudPanel sites untouched)
    └─ docker compose "ai-gateway" (cpus: 3.5, memory: 6g, low priority)
         ├─ gateway      Node/TS (Fastify): keys, limits, routing, queue, usage, metrics
         ├─ ollama       Qwen3-4B (Q4)  — OLLAMA_NUM_PARALLEL=2, MAX_LOADED_MODELS=1
         ├─ speech       faster-whisper small int8 (Python, 2 threads)
         └─ tts          Piper (voices per language)
```
- Gateway binds to `127.0.0.1` / Docker network only; exposed via **new nginx file**
  or Cloudflare tunnel, restricted to Koneqti server IPs + product keys.
- Lightweight on purpose: static product keys in env, usage in SQLite (Stage 0).
  LiteLLM / Postgres only considered from Stage 2 when multiple GPU backends exist.
- Existing `mesgai-brain/voice-engine/` (Chatterbox) moves into
  `services/voice-clone/` **disabled** until Stage 2 (add `arabic` and `turkish`
  mapping while moving).

---

## 3. Models (licences re-checked from licence files before shipping)
| Job | Stage 0 | Later | Licence |
|---|---|---|---|
| Chat / replies / extraction (JSON) | **Qwen3-4B Q4**, `enable_thinking: false` | Qwen3-8B (Stage 1 on demand, Stage 2 main) | Apache 2.0 |
| Classify (intent, language, safety score) | Qwen3-4B (same loaded model) | Qwen3-1.7B (Stage 1), fine-tuned XLM-R/mDeBERTa (later) | Apache 2.0 / MIT |
| Speech → text | **faster-whisper small int8** | medium (Stage 1), large-v3-turbo (Stage 2) | MIT |
| Voice activity | — | Silero VAD (Stage 2, calls) | MIT |
| Text → speech | **Piper** (check each voice licence) | Chatterbox Multilingual (Stage 2) | MIT |
| Urdu TTS | Piper Urdu voice if a suitable licensed one exists; else Hindi voice with **Urdu→Devanagari transliteration**; else text-only reply | Chatterbox + transliteration / better open Urdu voice | — |
| Vision/OCR (photo invoices/orders) | Not in Stage 0 (products use text/Excel paths) | Open VLM on GPU, e.g. Qwen2.5-VL (check licence per size) | — |
| Embeddings | — | BGE-M3 + bge-reranker-v2-m3 | MIT / Apache |
- Replace `qwen:1.5b` in all products.
- **Never use commercially:** XTTS-v2, F5-TTS weights, Meta MMS-TTS, Fish Speech weights.

---

## 4. Stage 0 server protection (mandatory)
1. Docker limits: `cpus: "3.5"`, `mem_limit: 6g`, `memswap_limit: 7g` for the whole
   AI stack; per-service limits inside.
2. Model threads = 3 (llama.cpp/Ollama `num_thread`), Whisper 2 threads; never more
   than the CPU limit.
3. **OOM priority:** AI containers `oom_score_adj: 800` → kernel kills AI before
   MySQL/PHP. Containers `restart: unless-stopped`.
4. Lower CPU priority for AI processes (`nice`), web always wins.
5. 4 GB swap file on host as safety net (not for speed).
6. Ollama env: `OLLAMA_NUM_PARALLEL=2`, `OLLAMA_MAX_LOADED_MODELS=1`,
   `OLLAMA_KEEP_ALIVE=10m`, `OLLAMA_MAX_QUEUE=64`.
7. Context 4096 tokens max; reply length decided by product (recommend 100–250 tokens
   for WhatsApp); **prompt caching on** (static system prompt + facts first).
8. Batch jobs (SEO, summaries, BlogBot) only in off-peak window (config, e.g.
   01:00–07:00 server time) or when realtime queue is empty.
9. Monitoring: Uptime Kuma on key sites + gateway `/health`; alert if host RAM > 85%,
   site response slows, or p95 reply > 20 s.
10. **Never** touch CloudPanel, MySQL, PHP-FPM or existing site configs; nginx: new
    file only, `nginx -t` before reload.

---

## 5. Capacity (Stage 0, estimate — confirm with benchmark)
- Qwen3-4B on ~3 cores: roughly 8–15 tokens/s → short reply ~5–20 s.
- ~3–6 replies/min (2 slots) → ~180–360 replies/hour.
- ≈ **20–30 active businesses** (~50 customer messages/day each), up to ~50 light users.
- Benchmark: `ollama run qwen3:4b --verbose "<Roman Urdu test>"` → eval rate;
  replies/min ≈ (eval_rate × 2 × 0.7) ÷ 150 × 60. Record results in STATUS.md.

---

## 6. API (OpenAI-compatible where possible)
| Endpoint | Stage 0 behaviour |
|---|---|
| `POST /v1/chat/completions` | Qwen3-4B via Ollama; streaming; `response_format: json_schema` for extraction |
| `POST /v1/audio/transcriptions` | faster-whisper small; returns text, language, confidence |
| `POST /v1/audio/speech` | Piper `{text, language, voice, format}`; unsupported language → `422 tts_language_unavailable` |
| `PUT/GET/DELETE /v1/voices/{business_id}` | `501 not_available_until_gpu` (Stage 2: Chatterbox with consent record + delete) |
| `POST /v1/safety/classify` | Qwen3-4B, forced JSON `{category, score}`; categories: medical, self_harm, violence, gas, electrical, flooding, carbon_monoxide, fire, none |
| `POST /v1/embeddings` | `501` until later stage |
| `GET /v1/models`, `/health`, `/metrics` | Status, queue length, latency, host RAM/CPU |

**Request headers:** `Authorization: Bearer <product key>`, `X-Tenant-Id`, `X-Task`,
`X-Priority` (`realtime | interactive | batch`), optional `X-Max-Latency-Ms`.
**Response headers:** `X-Model-Used`, `X-Queue-Ms`, `X-Usage` (tokens/seconds),
`X-Request-Id`.

---

## 7. Routing & queue (no external fallback)
`config/tasks.yaml` maps task → model + priority + timeout:
```yaml
reply:            { model: qwen3-4b, priority: realtime,    timeout_ms: 25000, max_tokens: 250 }
extract.order:    { model: qwen3-4b, priority: interactive, timeout_ms: 30000, json_schema: true }
extract.invoice:  { model: qwen3-4b, priority: interactive, timeout_ms: 30000, json_schema: true }
classify.intent:  { model: qwen3-4b, priority: realtime,    timeout_ms: 8000,  max_tokens: 20 }
classify.safety:  { model: qwen3-4b, priority: realtime,    timeout_ms: 3000,  max_tokens: 20 }  # product decides on timeout
summary:          { model: qwen3-4b, priority: batch }
seo.content:      { model: qwen3-4b, priority: batch }       # Stage 1: qwen3-8b on demand
translate.draft:  { model: qwen3-4b, priority: batch }
transcribe:       { service: speech, model: whisper-small-int8 }
tts:              { service: tts, engine: piper, languages: config/tts_languages.yaml }
```
- Internal priority queue: `realtime` > `interactive` > `batch`; batch only in
  off-peak window or when realtime queue is empty.
- **When a request can't meet its timeout:** return `503 busy` with `Retry-After`.
  Products handle it (MesgAI sends its reviewed holding reply and retries; safety
  falls back to the product's keyword filter).
- Per-product and per-tenant rate limits (requests/min, concurrent requests).

---

## 8. Rules
1. Private network only (IP allowlist + product key).
2. **No message content in logs** by default; log product, tenant, task, model,
   tokens/seconds, queue time, latency, status.
3. No outbound calls to external AI providers from this repo.
4. Voice samples (Stage 2): encrypted, consent record, working delete.
5. Model changes only after eval pass (§8.1).
6. Dataset capture for future AI Factory: off; only with tenant consent + task allow-list.

### 8.1 Evals
`evals/`: anonymised Urdu, Roman Urdu, Arabic (Gulf/Egyptian), Hindi, English,
Spanish, Portuguese chats; voice notes; emergency phrases. Measure language match,
facts adherence, JSON validity, latency, WER, safety recall. Switch models only if
equal or better and within latency.

---

## 9. Products → tasks
| Product | Uses |
|---|---|
| MesgAI | reply, classify.intent, classify.safety, transcribe, tts (Piper), extract.order (Shop Link), summary (morning brief) |
| KoneqtiSEO | seo.content, summary, translate.draft (batch) |
| Koneqti Leads | reply (drafts), classify.intent, summary |
| Tokofy | extract.order, transcribe, classify.intent |
| E-invoice app/site | extract.invoice (text/Excel), translate.draft, summary |
| BlogBot / PinForge | seo.content, summary, translate.draft (batch, off-peak) |

---

## 10. Migration (MesgAI first)
- Brain env: `AI_GATEWAY_URL`, `AI_GATEWAY_KEY` replace `OLLAMA_URL`, `WHISPER_URL`,
  `VOICE_ENGINE_URL`, `SAFETY_CLASSIFIER_URL`; old values kept behind
  `USE_AI_GATEWAY=true` until verified.
- Stop Ollama/Whisper on the Windows VPS after cutover (frees ~6.5 GB).
- Prompts, safety scripts, keyword filter, facts-only checks stay in the brain.
- Then Tokofy → KoneqtiSEO → Leads → e-invoice → BlogBot/PinForge.
- SDK `@koneqti/ai`: thin OpenAI-client wrapper adding headers + 503 handling.

---

## 11. Upgrade triggers
| Signal (7-day) | Move to |
|---|---|
| > 20–30 active businesses, or p95 reply > 20 s at peak, or site slowdowns | Stage 1 (own CPU server) |
| Need live AI calls/voice cloning, or Stage 1 p95 > 10 s | Stage 2 (GPU) |
| Stage 2 queue wait growing / > 200 businesses | Stage 3 |

---

## 12. Build order
1. Repo + docker compose with limits + `/health` + key check + usage log (SQLite).
2. Ollama Qwen3-4B + `/v1/chat/completions` (streaming, JSON schema) + tasks.yaml + priority queue + 503 handling.
3. Speech service (faster-whisper small) + `/v1/audio/transcriptions`.
4. Piper + `/v1/audio/speech`; move voice-engine (disabled) + arabic/turkish mapping.
5. `/v1/safety/classify`.
6. Metrics + Uptime Kuma checks + benchmark script.
7. SDK + switch MesgAI brain (flagged), evals, load test (`KONEQTI_SCALING_PLAN.md`).
8. Other products.

## 13. Acceptance tests
1. With AI at full load, CloudPanel sites respond within normal time (spot-check 3 sites).
2. AI stack can never exceed 3.5 CPUs / 6 GB (verify `docker stats` under load).
3. Simulated memory pressure → AI container killed/restarted, MySQL untouched.
4. Roman Urdu reply returned by Qwen3-4B; `X-Model-Used: qwen3-4b`; no text in logs.
5. `extract.order` returns schema-valid JSON.
6. Urdu voice note transcribed with language + confidence.
7. Queue full / timeout → `503 busy` + `Retry-After`; no request lost silently.
8. Batch task during peak waits until realtime queue empty or off-peak window.
9. No outbound network calls to external AI providers (egress check).
10. Benchmark script records eval rate and estimated capacity in STATUS.md.
