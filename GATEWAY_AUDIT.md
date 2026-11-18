# GATEWAY_AUDIT.md — Phase 0 audit for KONEQTI_GATEWAY_MASTER.md v1.0

Date: 18 Nov 2026. Audited code: branch `claude/upbeat-meitner-mqgp53`, commit `4d250cb`,
merged with `main` (which adds `KONEQTI_GATEWAY_MASTER.md`).
Status: **draft for owner approval** (master spec §20 Phase 0 exit criterion).
Updated with `MESGAI_GATEWAY_HANDOVER.md` (§7 below) and the owner's scope answers:
- **Image, Video and 3D packs + GPU lane (master §8.5–8.7, §9): later**, not in the current build.
- **`KONEQTI_SCALING_PLAN.md`: not needed** for this work.
- **D4 resolved by the handover:** MesgAI sends `X-Tenant-Id: mesgai` + `x-kq-subtenant: <business id>`.

---

## 1. Decisions the owner must make first (blocking)

The master spec changes four rules that `CLAUDE.md` (the repo's binding rules) and
`KONEQTI_AI_GATEWAY.md` v3 still say. I can't build those parts until `CLAUDE.md` is updated,
because it is written as "never break" and overrides other instructions in this repo.

| # | Existing rule (CLAUDE.md / v3 spec) | Master spec says | Needed decision |
|---|---|---|---|
| D1 | **Golden rule 1:** local models only, never call Claude/OpenAI/DeepSeek/Gemini/…, no API keys for them | T2 cheap cloud + T3 frontier models (§4.1), live call brain on a **fast cloud API** (§8.1), BYOK (§6), cloud image/video APIs (§8.5–8.6) | Allow external providers? If yes: rewrite rule 1 (e.g. "external providers only via the registry, behind a flag, per-tenant opt-in, never for tenants with `no_pii`/region limits"). If no: the gateway stays T0+T1 only and §4/§8.1 are cut down |
| D2 | **Golden rule 5:** gateway has no business logic — no prompts, business facts or safety decisions | Profiles carry `system_prompt_ref`, tone, tools, `post_steps` (summary, crm_update, cdr); T0 answers from business data; risk flags hand off to humans (§4.0, §8.1) | Do profiles/prompts/T0 FAQ move into the gateway, or stay in products with the gateway only storing a routing profile? |
| D3 | **Stage 0 host:** shared CloudPanel server, whole AI stack ≤ 3.5 CPU / 6 GB, everything in Docker, SQLite usage | Stack = PostgreSQL + Redis + BullMQ + PM2 + Next.js on a Contabo VPS (§0) | Same server or a new one? Postgres+Redis+dashboard in the same 6 GB would leave ~4 GB for Ollama — too little. Recommended: keep Docker (not PM2) and SQLite on the shared server for now; move to Postgres/Redis when the gateway gets its own server (Stage 1) |
| D4 ✅ | `X-Tenant-Id` = the business | Tenant from the key; `X-Tenant-Id` must equal it or 403; business = `x-kq-subtenant` | **Resolved:** the handover adopts the master rule. Built (Part 1) |

Smaller conflicts to confirm:
- Safety budget: config has `classify.safety` 3000 ms; master §3.1 says 1.5 s. Qwen3-4B on ~3 CPU likely can't do 1.5 s with a long prompt — needs the benchmark (§22.6).
- Priority names: code uses `realtime | interactive | batch`; master uses `realtime | normal | batch` (+ realtime must **never queue**, 503 at once; today realtime waits up to its timeout).
- Referenced documents not in this repo: `KONEQTI_SECURITY_STANDARD.md`, KoneqtiLoyalty spec (`requireApiKey`), `MESGAI_AMENDMENT_02_LIVE_TRANSLATED_CALLS.md` (Part 4). 3D Factory specs and the scaling plan are out of scope for now.
- The gateway has **not been deployed yet**, so no product calls it in production. That makes breaking changes cheap *now* — a good moment to settle the header contract.

---

## 2. What exists today

**Language/framework:** Node 22 + TypeScript strict + Fastify 5 + zod (gateway); Python FastAPI for speech/TTS. Master §0: "if existing code uses a different framework, keep it" → keep.

**Deployment:** `docker-compose.yml` — `gateway`, `ollama` (qwen3:4b Q4), `speech` (faster-whisper small int8), `tts` (Piper 1.2.0). Hard limits 3.5 CPU / 6064 MB RAM / 6950 MB RAM+swap, `oom_score_adj 800`, `nice 10`, models on an internal network with no internet. `setup` profile downloads models. Optional systemd slice. nginx file + Cloudflare tunnel example. `DEPLOY.md` runbook.

**Endpoints**
| Endpoint | Behaviour |
|---|---|
| `POST /v1/chat/completions` | OpenAI body, `X-Task` required → `config/tasks.yaml` → Ollama. Streaming SSE, `json_object` / `json_schema` (ajv-validated). Rejects tools, images, `n>1`. `model` field ignored |
| `POST /v1/audio/transcriptions` | multipart `file` ≤ 25 MB, any format PyAV decodes (ogg/opus, wav, mp3, m4a, webm). Returns `{text, language, language_probability, confidence, duration}` |
| `POST /v1/audio/speech` | `{input, language, voice?, response_format: wav|mp3|ogg|opus, speed?}`; Urdu → Devanagari → Hindi voice; unknown language → 422 `tts_language_unavailable` |
| `POST /v1/safety/classify` | `{text ≤ 4000, language?}` → `{category, score, model}` (JSON-schema forced) |
| `PUT/GET/DELETE /v1/voices/:business_id` | 501 `not_available_until_gpu` |
| `POST /v1/embeddings` | 501 |
| `GET /v1/models` | logical models + tasks + TTS languages |
| `GET /v1/usage` | per-product aggregates from SQLite |
| `GET /health`, `GET /metrics` | backends, queues, host RAM/load, p95, alerts; Prometheus |

**Auth:** product keys as SHA-256 hashes in `PRODUCT_KEYS` env (constant-time compare); IP allowlist (CIDR) incl. trusted-proxy handling; `X-Tenant-Id` required on work endpoints. No scopes, no key prefixes, no DB of keys.

**Limits & queue:** in-memory rate limits per product and per tenant (rpm + concurrent → 429). Three priority pools (`llm` 2 slots, `speech` 1, `tts` 1), realtime > interactive > batch; batch only off-peak or when no realtime waiting (max 1 batch at peak). Deadline from task timeout or `X-Max-Latency-Ms` → `503 busy` + `Retry-After`, never dropped. `X-Priority` may only lower priority.

**Storage:** SQLite `usage` table — ts, request_id, product, tenant, task, model, priority, status, error_code, queue_ms, latency_ms, tokens_in/out, audio_seconds, chars, stream. Retention pruning (180 days). No cost columns, no cache table.

**Logging/headers:** one metadata-only log line per request (tested: no prompt/reply/transcript text). Response headers `X-Model-Used`, `X-Queue-Ms`, `X-Usage` (`tokens_in=;tokens_out=;eval_ms=` / `audio_seconds=` / `chars=`), `X-Request-Id` (generated, incoming value ignored).

**Other:** `sdk/` (`@koneqti/ai`, 503 → `BusyError`), `evals/` (7-language chat, extraction, safety sets + baseline compare), `bench/run.js` (eval rate → capacity, load test, site spot-check → STATUS.md), `services/voice-clone/` placeholder (Chatterbox code not yet copied).

**Tests:** gateway 34 (vitest) · speech 8 · tts 10 · sdk 5 · evals 4 — all pass. Not yet done: real Docker build, real models, any on-server acceptance test.

---

## 3. Master spec → current state

`exists` = done and matches · `partial` = something there, needs change · `missing` = not built · `blocked` = needs a decision from §1 first.

| § | Item | State | Notes |
|---|---|---|---|
| 0 | Audit | exists | this file |
| 1.3 | Use existing engines only | exists | Ollama, faster-whisper, Piper |
| 2 | Architecture: auth → budget → policy → cache → router → lanes → quality → ledger | partial | auth → queue → single model. No budget, policy, cache, router, quality step or ledger costs |
| 3 | `x-kq-quality/latency-ms/max-cost/route/cache` hints | missing | only `X-Max-Latency-Ms` (≈ `x-kq-latency-ms`) |
| 3 | `x-kq-route: pin:<model>` | missing | `model` field ignored today |
| 3 | Response headers `x-kq-model/tier/cost-usd/baseline-usd/cache` | partial | `X-Model-Used` exists; others missing |
| 3.1 | Priority pools | exists (Part 1) | `realtime/normal/batch`, realtime never queued (503 at once), reserved realtime slots per pool, batch yields to normal |
| 3.1 | Time budgets 2 s / 25 s / 1.5 s / 60 s | exists (Part 1) | 1.5 s safety still to be proven on the CPU |
| 4.0 L1 | Entry points per modality | partial | chat/transcriptions/speech exist; `WS /v1/packs/voice/session`, `/v1/audio/messages`, `/v1/jobs`, `/v1/packs/docs/extract` missing |
| 4.0 L2 | Profiles (`x-kq-profile`, profiles table, defaults) | partial / blocked (D2) | `tasks.yaml` is a simple profile (model, priority, timeout, max_tokens, json). No table, no tenant override, no pipeline steps |
| 4.0 L3 | Language ID, intent classifier, risk flags | missing | `classify.intent` task exists but the product calls it; gateway doesn't classify by itself |
| 4.0.1 | native / pivot language modes, working language, `lang_quality` | missing | |
| 4.0.1 | No TTS in a language without a good voice → text | exists | 422 → product sends text |
| 4.1 | Tiers T0–T3 | partial / blocked (D1, D2) | only T1 (local Qwen3-4B). T0 needs business data (D2); T2/T3 need cloud (D1) |
| 4.2 | Classifier (heuristics + T1 JSON) | missing | |
| 4.3 | `chooseRoute` | missing | |
| 4.4 | Quality check & escalation | partial | JSON validity + schema check exist (→ 502). No refusal/truncation/language check, no escalation (nothing to escalate to without D1) |
| 4.5 | Nightly learning-loop proposals | missing | |
| 5 | Exact cache (per tenant) | missing | needs a store: SQLite works for Stage 0; Redis later |
| 5 | Semantic cache (pgvector) | missing | needs embeddings + vector store (§8.3) |
| 5 | Provider prompt caching | partial | Ollama reuses KV prefix; no cached-token accounting |
| 6 | Model registry (table) | partial | `models:` in `tasks.yaml` (backend, licence) — no tiers, prices, health, context, circuit breaker |
| 6 | Encrypted provider keys, BYOK | blocked (D1) | |
| 7 | `/v1/jobs`, BullMQ lanes, webhooks | missing | batch exists only as a low-priority synchronous request |
| 8.1 A | Live calls (VAD, streaming ASR/TTS, barge-in) | missing / blocked (D1) | spec requires a cloud brain for live turns |
| 8.1 B | Voice-note flow `/v1/audio/messages` | partial | pieces exist (ASR, chat, TTS→ogg/opus); no combined endpoint, no webhook, no mirror mode |
| 8.1 C | 8 kHz vs 16 kHz WER gate | partial | `evals/` has WER code; no 8 kHz set |
| 8.1 D | Voice cloning with consent + speaker verification | missing | 501 placeholder; no consent sentences, no speaker-verification model chosen ⚠️ licence |
| 8.1 E | Live translated calls | missing | last phase |
| 8.1 | BCP-47 codes incl. `ur-Latn`, `hi-Latn` | partial | ISO-639-1 2-letter codes only; Roman Urdu has no TTS |
| 8.2 | Document Pack (OCR → extraction → field confidence) | partial | `extract.invoice` (text only); no OCR, no field confidence |
| 8.3 | Embeddings Pack | missing | `/v1/embeddings` = 501. A small local model (e.g. BGE-M3) needs RAM inside the 6 GB cap |
| 8.4 | Content Pack | partial | `seo.content`, `summary`, `translate.draft` batch tasks; no variants, checks or async lane |
| 8.5–8.7 | Image / Video / 3D packs | later (owner) | out of current scope |
| 8.8 | Benchmark first | partial | `bench/run.js` ready, not yet run on the VPS |
| 9 | GPU job lane | later (owner) | out of current scope |
| 10 | `usage_ledger` with cost + baseline + overhead | partial | SQLite `usage` has tokens/latency/status; no cost, baseline, modality, cache, escalations, subtenant |
| 10.1 | Savings formula / report | missing | local-only: cost = measured VPS cost ÷ throughput; baseline = declared model at list price |
| 11 | Tenants + hashed keys | partial | hashed keys in env; no tenants table, no prefix shown, no scopes |
| 11 | Budgets (daily/monthly, block/downgrade/alert) | missing | needs cost per request first |
| 11 | Rate limits per key (token bucket) | partial | per product + per tenant fixed-window, in memory |
| 11 | `internal=true` tenants | missing | all callers are internal today |
| 11.1 | Subtenants (`x-kq-subtenant`, auto-create, settings, data delete, `subtenant_limit` 429) | exists (Part 1) | strict `X-Tenant-Id` match → 403 |
| 12 | Billing / Stripe | missing | Phase 6 |
| 13 | Golden sets, eval gate, shadow mode, rollback | partial | `evals/` + baseline compare (CLI); no shadow mode, no versioned rules |
| 14 | Prometheus metrics | partial | requests, latency, queue, tokens, host RAM, reply p95; no tier/cache/escalation/cost metrics |
| 14 | OpenTelemetry traces | missing | |
| 15 | Metadata-only logs by default | exists | tested |
| 15 | PII detector, data region routing, encrypted provider keys | missing / blocked (D1) | |
| 16 | New tables | missing | only `usage` exists |
| 17 | `GET /v1/models` with `kq/auto` | partial | lists logical models; no `kq/auto` |
| 17.1 | Transcription: formats incl. 8 kHz, `duration_sec` | exists (Part 1) | WER-at-8 kHz report still to do |
| 17.1 | Speech: `ogg_opus · mp3 · mulaw_8k · pcm_16k`, `stream:true` | partial | formats done; `stream` → 501 until Part 4 |
| 17.1 | Safety ≤ 1000 chars, < 1.5 s | exists (Part 1) | latency to be measured |
| 17.1 | `POST /v1/translate` | missing | `translate.draft` exists as a chat task only |
| 17.1 | `WS /v1/realtime/transcribe` | missing | needs streaming ASR |
| 17.1 | Voices API (consent sentence, multipart create, list, delete) | missing | different paths from today's `/v1/voices/:business_id` (501) |
| 17.1 | `GET /v1/usage?subtenant=&from=&to=` | exists (Part 1) | |
| 17.1 | `PUT /v1/subtenants/:id/settings`, `DELETE /v1/subtenants/:id/data` | exists (Part 1) | |
| 17.2 | `x-kq-*` request headers; `X-Task` as legacy alias of profiles | partial | `x-kq-subtenant`, `x-kq-priority` done; `x-kq-profile`, quality/route/cache hints not yet |
| 17.2 | `X-Request-Id` from caller echoed back | exists (Part 1) | |
| 17.2 | `x-kq-usage-tokens`, `x-kq-usage-audio-sec` | exists (Part 1) | `X-Usage` kept |
| 18 | Next.js dashboard | missing | Phase 6 (and too heavy for the shared server) |
| 19 | Products send `x-kq-product` | partial | product comes from the key already (more reliable than a header) |
| 21 | CLAUDE.md rules | missing / D1–D4 | several new rules contradict current ones; owner rewrites CLAUDE.md |

---

## 4. Breaking-change risks for products

No product calls the gateway in production yet (not deployed). MesgAI has been told the current contract (OpenAI-style, `X-Task`, `X-Tenant-Id` = business, `qwen3-4b`, 503 busy). Risks if the master spec is applied literally:

| Change | Who breaks | Mitigation |
|---|---|---|
| `X-Tenant-Id` must match key tenant else 403 (§11.1) | MesgAI (sends business id) | D4: legacy `X-Tenant-Id` → subtenant when `x-kq-subtenant` absent |
| `X-Tenant-Id` no longer required | none | relax requirement once `x-kq-subtenant` exists |
| Priority `interactive` → `normal` | callers sending `X-Priority: interactive` | accept both names; new header `x-kq-priority`, keep `X-Priority` |
| Realtime → 503 immediately instead of waiting | MesgAI replies (`reply` is realtime today, 25 s budget) | per master, chat replies are **normal**, not realtime → move `reply` to `normal`; realtime reserved for live call audio |
| Safety budget 3 s → 1.5 s | MesgAI safety (more 503s → more keyword-filter fallback) | benchmark first; keep 3 s until measured |
| Safety max 4000 → 1000 chars | callers sending long text | truncate-and-classify or 400; decide |
| `duration` → `duration_sec` | SDK, evals | return both |
| TTS format names `ogg` → `ogg_opus` | SDK default `ogg` | accept both |
| `/v1/voices/:business_id` paths change | nobody (501 today) | replace freely |
| `model` field starts to matter (`kq/auto`, `pin:`) | callers sending arbitrary `model` strings | treat unknown/legacy model names as `kq/auto` |
| Response header names | SDK reads `X-Model-Used`, `X-Usage` | send old and new headers together |
| SQLite → Postgres | ops only | migrate `usage` rows; behind D3 |

---

## 5. Proposed build order (fits master §20, respects the current CLAUDE.md until D1–D4 are decided)

**Can start now (local-only, no rule conflict):**
1. **Phase 1b-A — header contract & compatibility** (behind `KQ_HEADERS=1`): `x-kq-subtenant` / `x-kq-profile` / `x-kq-priority`, legacy alias map (`X-Task`, `X-Tenant-Id`, `X-Priority`), `normal` priority name, caller `X-Request-Id` echoed, new response headers alongside old, `duration_sec`, `429 subtenant_limit`.
2. **Phase 1b-B — audio & privacy:** TTS `ogg_opus/mulaw_8k/pcm_16k` + chunked `stream:true`; 8 kHz input tests; subtenant settings (`retention_days`, `allow_cache`) + `DELETE /v1/subtenants/:id/data`; safety 1000-char limit; realtime pool that 503s immediately.
3. **Phase 1 (local part):** registry with tiers/prices/health/circuit breaker as config (YAML/SQLite), ledger columns (`cost_usd` from measured VPS cost, `baseline_usd`, `cache`, `tier`, `subtenant`), per-tenant exact cache (SQLite, TTL per task), `x-kq-route: pin:`, `kq/auto` in `/v1/models`, `GET /v1/savings`, budgets.
4. **Phase 0.5 — deploy + benchmark** on the VPS (DEPLOY.md). Needed before any latency decision (1.5 s safety, realtime turn, concurrent T1 capacity).

**Needs a decision first:**
- T2/T3 providers, live-call brain, BYOK, cloud image/video → **D1**.
- T0 FAQ / profile prompts / post-call steps inside the gateway → **D2**.
- Postgres/Redis/BullMQ/Next.js dashboard → **D3** (or a second server).
- Strict tenant header → **D4**.
- Voice cloning → choose speaker-verification + cloning models with a commercial licence ⚠️; GPU (Stage 2) per v3 spec.
- GPU lane, Video/3D packs, billing, external launch → Phases 5–7.

## 6. Open checks carried from master §22
1. ✅ Current state — this file.
2. Cloud providers/prices — only if D1 = yes.
3. ASR/TTS commercial licences + Urdu/Arabic/Spanish/Portuguese quality — Piper MODEL_CARDs pending (`STATUS.md` owner step 4).
4. OCR quality — not started.
5. GPU providers — not started.
6. VPS capacity — `bench/run.js` ready, run on deploy.
7. Savings Share legal wording — owner.
8. Competitor check — later.

---

## 7. MesgAI handover review (`MESGAI_GATEWAY_HANDOVER.md`)

### 7.1 Built now — handover Part 1 (commit after this audit)
| Handover item | State |
|---|---|
| §0 headers: tenant from key, `X-Tenant-Id` must match (403 `tenant_mismatch`), `x-kq-subtenant` required on work endpoints (`system` allowed), `x-kq-priority` (`realtime/normal/batch`; legacy `X-Priority`, `interactive` = `normal`), caller `X-Request-Id` echoed | ✅ |
| §0 response headers `X-Model-Used` (+ `x-kq-model`), `x-kq-usage-tokens`, `x-kq-usage-audio-sec`, `Retry-After` | ✅ (streams put usage in the last SSE chunk) |
| §0 errors: `429 subtenant_limit` (other businesses unaffected), 401/403/400/503 | ✅ (tenant-wide limit → `429 tenant_limit`) |
| §1.1 chat body, `model: "auto"` ignored | ✅ |
| §1.2 transcription formats ogg/opus, wav 8 kHz + 16 kHz, m4a, mp3, webm; `duration_sec` | ✅ decoding tested for every format; `duration` kept as alias. **8 kHz WER test per language: still to do on the server** (needs real phone-audio test set) |
| §1.3 safety ≤ 1000 chars, 1.5 s budget | ✅ (413 over 1000; `classify.safety` timeout 1500 ms, jumps the normal queue). ⚠️ May often 503 on Stage 0 CPU → keyword filter; measure |
| §1.4 realtime never queues, 503 at once; batch never takes reserved workers; budgets 2 s / 25 s / 1.5 s / 60 s | ✅ `reserved_realtime` per pool (0 on the Stage 0 server: no live calls there) |
| §1.5 `GET /v1/usage?subtenant=&from=&to=` → `by_task` | ✅ (keys are gateway task names: `reply`, `transcribe`, `tts`, …) |
| §1.6 `PUT /v1/subtenants/:id/settings`, `DELETE /v1/subtenants/:id/data`, metadata-only logs, audio not kept | ✅ (gateway stores no content/cache/voices yet, so delete = ledger rows + settings) |
| §2.1 speech formats `ogg_opus · mp3 · mulaw_8k · pcm_16k`, BCP-47 language, stock voice ids | ✅ (`ogg`/`opus`/`wav` still accepted). Cloned `v_…` ids → 404 until §2.2 exists |

### 7.2 Not built yet
| Item | Why / what's needed |
|---|---|
| §2.2 voice cloning with consent + speaker check | Needs model choice with **commercial** licences (cloning + speaker verification) and CPU feasibility — owner decision. v3 spec planned Chatterbox on GPU (Stage 2) |
| §3 `/v1/translate` | Next (local Qwen3-4B + per-subtenant cache). `ur-Latn` quality to be measured |
| §4 live transcribe WS, streaming TTS, per-turn timings | Last. Needs streaming ASR; not on the shared Stage 0 server |
| 8 kHz vs 16 kHz WER report | Needs a recorded test set (Urdu, Arabic, English, Spanish, Roman Urdu code-switching) |

### 7.3 Answer to handover §7 (send back to MesgAI)
All items in handover §7 are already in `KONEQTI_GATEWAY_MASTER.md` (§3.1, §8.1 C–E, §11.1, §17.1–17.2). Differences to settle:
1. **Safety categories.** Handover: `none | self_harm | medical_emergency | threat | …`. Gateway (v3 spec, `config/safety.yaml`): `medical, self_harm, violence, gas, electrical, flooding, carbon_monoxide, fire, none`. Pick one list.
2. **Licence field name.** Handover `license_commercial`; master `licence_ok`. Gateway will use `licence_ok` (master is the source of truth).
3. **Usage keys.** `by_task` uses gateway task names: `transcribe` (not `transcription`), `tts`, `reply`, `classify.safety`, …
4. **Key naming.** `X-Tenant-Id` must equal the tenant the key was issued for, so MesgAI's key is created as product `mesgai`.
5. **Stock voices.** `voice` = the Piper voice listed in `GET /v1/models` → `tts_languages`. Roman Urdu (`ur-Latn`) has no voice → `422 tts_language_unavailable` → send text.
6. **`stream: true`** → `501 stream_not_available_yet` until Part 4.
7. **Realtime on the current server:** no reserved workers (no live calls in Stage 0), so `realtime` gets a worker only if one is free, else `503` at once.
