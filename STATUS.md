# STATUS — koneqti-ai-gateway

**Stage 0 — built, not yet deployed.** Nov 2026: MesgAI handover Part 1 contract built
(subtenants, `x-kq-*` headers, realtime pool, per-business usage/privacy, new audio formats) —
see `GATEWAY_AUDIT.md` §7 for the handover review and the master-spec gap table.
19 Nov 2026: **target server is now VPS2** (24 GB, shared with all product backends; products call
`127.0.0.1:8787`). Added the per-business answer cache (`x-kq-cache: hit|miss|off`) and a realistic
benchmark (~900-token MesgAI prompt, prompt reading vs reply writing, new vs returning business). Code, tests, compose file and deploy runbook are ready;
deployment to the CloudPanel VPS and the on-server acceptance checks are the next step (`DEPLOY.md`).

## What is built (spec §12 build order)
| Step | State |
|---|---|
| 1. Repo, docker compose with limits, `/health`, key check, usage log (SQLite) | ✅ |
| 2. Ollama Qwen3-4B, `/v1/chat/completions` (streaming, JSON schema), `tasks.yaml`, priority queue, 503 handling | ✅ |
| 3. Speech service (faster-whisper small int8) + `/v1/audio/transcriptions` | ✅ |
| 4. Piper + `/v1/audio/speech` (Urdu → Devanagari → Hindi voice); voice-clone folder (disabled) with arabic/turkish map | ✅ — Chatterbox code itself still to be copied from `mesgai-brain/voice-engine/` (not in this repo) |
| 5. `/v1/safety/classify` | ✅ |
| 6. Metrics (`/metrics`, `/health` alerts), Uptime Kuma checklist, benchmark script | ✅ |
| 7. SDK `@koneqti/ai` (`sdk/`), evals (`evals/`), load test (`bench/run.js --load`) | ✅ — MesgAI brain switch happens in the brain repo |
| 8. Other products | ⏳ after MesgAI cutover |

## Components
- `gateway/` — Node 22 / TypeScript strict / Fastify 5 / zod / better-sqlite3 / prom-client.
  Product keys (sha256 in env), IP allowlist (CIDR), per-product + per-tenant rate limits
  (rpm + concurrent), priority pools `llm` (2 slots = `OLLAMA_NUM_PARALLEL`), `speech` (1), `tts` (1).
  Priorities `realtime | normal | batch`: realtime is never queued (reserved slot, else a free one,
  else 503 at once); `fast` tasks (classify) jump the normal queue; batch yields to normal and at
  peak runs ≤ 1 at a time.
  Deadline = task `timeout_ms` (or shorter `X-Max-Latency-Ms`) → `503 busy` + `Retry-After`,
  also recorded in usage. Every response sets `X-Model-Used`, `X-Queue-Ms`, `X-Usage`, `X-Request-Id`.
  Logs: one metadata line per request (product, tenant, task, model, tokens, queue ms, latency, status).
- `services/speech/` — FastAPI + faster-whisper `small` int8, 2 threads, VAD filter, beam 1.
  Returns `text, language, language_probability, confidence, duration`.
- `services/tts/` — FastAPI + Piper (`piper-tts==1.2.0`, last MIT release), ffmpeg for mp3/ogg-opus.
- `docker-compose.yml` — limits total **3.5 CPU / 6064 MB RAM / 6950 MB RAM+swap**,
  `oom_score_adj: 800`, `cpu_shares: 256`, `nice -n 10`, `restart: unless-stopped`;
  model services on an `internal` network (no internet). Optional `docker-compose.slice.yml`
  + `ops/systemd/koneqti-ai.slice` for a shared 3.5 CPU / 6 GB cap with bursting.

## API summary
| Endpoint | Notes |
|---|---|
| `POST /v1/chat/completions` | `X-Task` required; OpenAI body (`model` ignored); `stream`; `response_format` json_object/json_schema (validated with ajv → 502 `schema_validation_failed`); prompt > `MAX_CONTEXT_TOKENS` → 400 |
| `POST /v1/audio/transcriptions` | multipart `file` ≤ 25 MB (ogg/opus, wav 8/16 kHz, m4a, mp3, webm), optional `language` → `{text, language, language_probability, confidence, duration_sec}` |
| `POST /v1/audio/speech` | `{input, language (BCP-47), voice?, format: ogg_opus·mp3·mulaw_8k·pcm_16k·wav, speed?}`; unknown language (incl. `ur-Latn`) → 422 `tts_language_unavailable`; `stream:true` → 501 (Part 4) |
| `POST /v1/safety/classify` | `{text ≤ 1000, language?}` → `{category, score, model}`; 1.5 s budget → 503 so the product uses its keyword filter |
| `GET /v1/usage?subtenant=&from=&to=` | `by_task` totals for one business, or the whole tenant |
| `GET/PUT /v1/subtenants/:id/settings`, `DELETE /v1/subtenants/:id/data` | `{retention_days, allow_cache}`; delete removes the business's ledger rows + settings |
| `PUT/GET/DELETE /v1/voices/:id` | 501 (cloning not built) |
| `POST /v1/embeddings` | 501 |
| `GET /v1/models` | models + tasks + stock TTS voices |
| `GET /health`, `GET /metrics` | IP allowlist only (no key). `/health` 503 if Ollama down / model not pulled |

Request headers: `Authorization: Bearer <key>` (tenant = the key's product), `X-Tenant-Id`
(optional; must equal the key's tenant, else 403), `x-kq-subtenant` (business id or `system`;
required on work endpoints), `X-Task`, `x-kq-priority` (`realtime|normal|batch`; legacy `X-Priority`,
`interactive` = `normal`), `X-Max-Latency-Ms` (may only shorten), `X-Request-Id` (echoed back).
Response headers: `X-Model-Used` + `x-kq-model`, `x-kq-usage-tokens`, `x-kq-usage-audio-sec`,
`X-Queue-Ms`, `X-Usage` (`tokens_in=…;tokens_out=…;eval_ms=…` / `audio_seconds=…` / `chars=…`),
`X-Request-Id`, `Retry-After` with 503/429. Errors: `429 subtenant_limit` (one business over its
limit) / `tenant_limit`, `403 tenant_mismatch`, `400 subtenant_required`.

## Environment variables
`GATEWAY_PORT` (8787), `GATEWAY_BIND` (127.0.0.1), `PRODUCT_KEYS`, `ALLOWED_IPS`, `TRUST_PROXY`,
`OLLAMA_URL`, `SPEECH_URL`, `TTS_URL`, `OFFPEAK_WINDOW`, `TZ`, `MAX_CONTEXT_TOKENS` (4096),
`LOG_LEVEL`, `USAGE_RETENTION_DAYS` (180), `VOICE_CLONE_ENABLED` (false), `OLLAMA_NUM_PARALLEL` (2),
`OLLAMA_KEEP_ALIVE` (10m), `OLLAMA_MODEL`, `OLLAMA_IMAGE`, `AI_EDGE_SUBNET`, `SERVICE_LOG_LEVEL`.
Compose also sets `OLLAMA_MAX_LOADED_MODELS=1`, `OLLAMA_MAX_QUEUE=64`, `OLLAMA_CONTEXT_LENGTH`.
See `.env.example`.

## Tests (run in the build environment)
| Suite | Result |
|---|---|
| `npm --prefix gateway run typecheck` | ✅ clean (strict) |
| `npm --prefix gateway test` (vitest) | ✅ 46 passed — answer cache (hit/miss/off, per business, deleted with the business), queue priorities (realtime instant 503, fast jobs, batch gating), deadlines, auth, tenant/subtenant contract, subtenant limits, usage per business, settings/delete, chat + streaming, JSON schema, 503 + Retry-After, no text in logs, audio routes + formats, 422/501, health, DB migration |
| `pytest services/speech` | ✅ 15 passed (fake model + real decoding of wav 8/16/44.1 kHz, ogg/opus, mp3, m4a, webm) |
| `pytest services/tts` | ✅ 16 passed (fake voice; real ffmpeg for ogg_opus/mp3/mulaw_8k/pcm_16k; Urdu→Devanagari) |
| `npm --prefix sdk test`, `npm --prefix evals test` | ✅ 5 + 4 passed |
| `docker compose config` (base + slice override) | ✅ valid; limits sum checked |
| End-to-end: built gateway + fake Ollama → `bench/run.js` + `evals/run.js` | ✅ scripts run, headers/usage/logs correct |
| `docker compose build` / real models | ⚠️ not run: the build sandbox could not reach Debian/GitHub/Hugging Face. Do it on the VPS (DEPLOY.md §5–7). |

## Benchmarks
<!-- BENCH:START -->
Not run yet — needs the real server. `node bench/run.js` fills this in.
<!-- BENCH:END -->

<!-- BENCH:HISTORY (newest first) -->
| date (UTC) | model | eval rate tok/s | est. replies/min | est. businesses | realistic reply new / returning | load p95 |
|---|---|---|---|---|---|---|

Estimate before measuring (spec §5): 8–15 tok/s → 3–6 replies/min → ~20–30 active businesses.

## Answer cache (master spec §5, exact match only)
Tasks with `cache_ttl_s` in `config/tasks.yaml` and temperature ≤ 0.3: `classify.safety`,
`classify.intent` (7 days), `extract.order`, `extract.invoice` (1 day — shorter than the master
spec's 30 days because orders contain names/addresses). Replies are never cached.
Per business (`x-kq-subtenant`), off with `x-kq-cache: off` or the business's `allow_cache: false`.
Only a sha256 of the request is stored, never the prompt; answers expire and are removed by
`DELETE /v1/subtenants/:id/data`. Response header `x-kq-cache`; hits cost 0 tokens and show as
`cache_hits` in `/v1/usage`.

## Owner manual steps (see DEPLOY.md)
1. Approve/do: Docker (if missing), 4 GB swap file.
2. Create product keys (MesgAI's as product `mesgai`); fill `.env` (`PRODUCT_KEYS`, `ALLOWED_IPS`, `TZ`).
3. Run the `setup` profile once (downloads Qwen3-4B, Whisper small, Piper voices).
4. **Read each Piper voice MODEL_CARD** and set `licence_checked: true` (or disable the language).
5. Choose exposure: new nginx file (`nginx -t` then reload) **or** Cloudflare Tunnel + Access.
6. Run the acceptance checks + benchmark and paste results here.
7. Pin `OLLAMA_IMAGE` to the tested version.
8. Copy `mesgai-brain/voice-engine/` into `services/voice-clone/` (stays disabled).

## Known gaps / decisions
- **Voice names** in `config/tts_languages.yaml` (hi_IN-pratham, ar_JO-kareem, …) are from the
  Piper catalogue as remembered; `tts-setup` checks them against the live `voices.json` and
  lists alternatives if one is missing. Urdu has no Piper voice → Hindi voice + rule-based
  Urdu→Devanagari transliteration (approximate; common words from a table). Roman Urdu has no TTS.
- CPU split: Ollama gets 2.6 CPU with `num_thread: 3` (spec), so it is lightly throttled at full
  load. The slice override removes that by letting services share the 3.5 CPU cap. Decide after
  the benchmark.
- Safety classifier instruction lives in `config/safety.yaml` (a generic classifier definition,
  not a decision — products still decide what to do with the score).
- Context check is an estimate (~3 chars/token); Ollama's real count comes back in `X-Usage`.
- Rate limits and queues are in-memory (single gateway process, Stage 0). Restarting the gateway
  answers queued requests with 503.
- Tool calling, images and `n > 1` are rejected in Stage 0.
- Not built from the handover yet: voice cloning (needs licence-checked models), `/v1/translate`,
  live-call streaming (Part 4), the 8 kHz WER report. Master-spec router/ledger costs/cache: see `GATEWAY_AUDIT.md`.
- Safety in 1.5 s on the Stage 0 CPU is unproven — expect 503s (keyword filter) until benchmarked.
- Limits are still 3.5 CPU / 6 GB from the first server. VPS2 has 24 GB but shares it with every
  backend; raising them needs the owner's written OK after the benchmark (see GATEWAY_AUDIT §8.4).
- Tests need Node 22 (vitest 5); the gateway itself runs on Node 20+ (the image uses Node 22).
