# KONEQTI GATEWAY — MASTER BUILD SPEC v1.0
> "Change one line, cut your AI bill."
> Upgrade spec for the **existing Koneqti AI Gateway codebase** + the compute layer for **AI Factory (Reelora/KoneqtiStudio)** and **3D Factory**.
> Date: 18 Nov 2026 | Founder: Muhammad Safdar
> Legend: ✅ decided · ⚠️ verify before relying on it · 💲 estimate, measure in production

---

## 0. READ THIS FIRST (INSTRUCTIONS FOR CLAUDE CODE)

The AI Gateway already exists. **Do not rewrite it.** Upgrade it.

**Phase 0 — Audit (before any new code):**
1. Read the existing gateway repo end to end.
2. Produce `GATEWAY_AUDIT.md` with:
   - What exists: endpoints, providers, local models (e.g. Qwen3-4B), queue, DB tables, auth, logging.
   - A table mapping every section of this spec → `exists` / `partial` / `missing`.
   - Breaking-change risks for products already calling the gateway.
3. Keep every existing endpoint working. New behaviour goes behind feature flags until tested.
4. Then implement in the phase order of Section 20.

**Stack (same as all Koneqti products):** Node.js + TypeScript · PostgreSQL · Redis + BullMQ · PM2 · Next.js 14 dashboard · Contabo VPS. Local inference via llama.cpp server / Ollama on CPU. If the existing code uses a different language or framework, keep it and adapt this spec.

---

## 1. PRODUCT

### 1.1 One sentence
An OpenAI-compatible endpoint that sends every AI request to the **cheapest option that still meets the quality bar**: rules, cache, free local CPU models, cheap APIs, or frontier models. It also runs heavy GPU jobs (video, 3D) on rented GPUs only when needed.

### 1.2 Who uses it
| Phase | Customer | Why |
|---|---|---|
| 1 | **All Koneqti products** (internal) | Lower cost on MesgAI, KoneqtiSEO, BlogBot, SocialKoneqti, Leads, AI Factory, 3D Factory. Produces real savings data |
| 2 | Small SaaS builders, agencies, startups | One-line change, measurable savings |
| 3 | Larger teams | Self-hosted gateway, private models, SLA |

### 1.3 What we never build
- Our own compiler / IR / kernels.
- Our own hardware.
- Our own public distributed compute network.
Use llama.cpp, vLLM, ONNX Runtime and others as engines. Our value is in **deciding where each request runs**, caching, workload packs and measuring savings.

---

## 2. ARCHITECTURE

```
Client (Koneqti product or external customer)
   │  OpenAI-compatible API  (/v1/chat/completions, /v1/embeddings, /v1/audio/*)
   │  + Koneqti APIs         (/v1/jobs, /v1/packs/*)
   ▼
┌───────────────────────── GATEWAY API (Node/TS) ─────────────────────────┐
│ Auth & tenant → Budget check → Policy → Cache lookup → Router           │
│        │                                         │                       │
│        ▼                                         ▼                       │
│  Real-time lane                           Async / batch lane (BullMQ)   │
│  T0 rules · T1 local CPU ·                cheap batch APIs · local CPU  │
│  T2 cheap API · T3 frontier               GPU job lane (rented GPUs)    │
│        │                                         │                       │
│        └──── Quality check → escalate if weak ───┘                       │
│                         │                                                │
│                  Cost ledger (actual vs baseline)                       │
└──────────────────────────────────────────────────────────────────────────┘
   │                 │                  │                    │
 Local models     Cloud providers    GPU workers          Postgres / Redis
 (VPS CPU)        (config-driven)    (rented, on demand)  (ledger, cache, registry)
```

---

## 3. REQUEST LIFECYCLE (REAL-TIME)

```
1. Authenticate API key → tenant, plan, budgets.
2. Read routing hints: header `x-kq-quality` (low|standard|high|max),
   `x-kq-latency-ms`, `x-kq-max-cost`, `x-kq-route` (auto|pin:<model>), `x-kq-cache` (on|off).
3. Budget gate: reject or downgrade if tenant monthly/daily cap reached (policy per tenant).
4. Cache lookup (exact → semantic). Hit → return, log cost 0 + baseline.
5. Classify request → task_type + difficulty score (Section 4.2).
6. Pick tier + model from registry (Section 4.3).
7. Call model (streaming supported). Timeout + fallback chain.
8. Quality check (Section 4.4). Fail → escalate one tier, max 2 escalations.
9. Write cache (if cacheable), write ledger row, emit usage event.
10. Return response with headers:
    x-kq-model, x-kq-tier, x-kq-cost-usd, x-kq-baseline-usd, x-kq-cache (hit|miss)
```

`x-kq-route: pin:<model>` always bypasses the router (customers must be able to force a model).

### 3.1 Priority pools (merged from MesgAI handover ✅)
- `realtime` runs on its **own reserved CPU workers** (ASR/TTS/VAD) and reserved API concurrency. Never shared with `normal` or `batch`.
- Reserved pool full → `503` with short `Retry-After` **immediately** (caller falls back; a phone caller can't wait).
- `normal` (chat replies, voice notes) and `batch` (summaries, broadcasts, reports) share the general pool; `batch` yields to `normal`.
- Caller time budgets to respect: realtime turn ≈ 2 s · chat reply 25 s · safety 1.5 s · transcription 60 s.

---

## 4. ROUTER

### 4.0 How the gateway recognizes what is coming (3 layers)
The gateway never has to guess from zero. Recognition happens in this order:

**Layer 1 — Entry point = modality (100% certain)**
| Entry | Means |
|---|---|
| `WS /v1/packs/voice/session` | Live phone/web call (real time) |
| `POST /v1/audio/messages` | Voice note (WhatsApp/Telegram audio file), async |
| `POST /v1/audio/transcriptions`, `/v1/audio/speech` | Raw ASR / TTS |
| `POST /v1/chat/completions` | Text (chat or writing) |
| `POST /v1/jobs` | Batch / long jobs (blogs, video, 3D) |
| `POST /v1/packs/docs/extract` | Documents |

**Layer 2 — Use-case profile (declared by the product)**
Every call sends `x-kq-profile: <product>.<use_case>`. A profile is a config row that fixes the pipeline: models per step, latency target, reply format, tone, quality floor, language rules, post-processing.

```sql
profiles(
  id TEXT PRIMARY KEY,            -- 'mesgai.voice_note'
  tenant_id UUID NULL,            -- NULL = Koneqti default, tenant can override
  modality TEXT,                  -- call|voice_note|text|job|doc
  task_type TEXT,                 -- support|sales_sdr|faq|blog|caption|title|story|script|chat|summary
  latency_target_ms INT,
  quality_floor TEXT,             -- T0..T3
  live_brain TEXT,                -- 'fast_api' | 'local' (calls must use fast_api, see 8.1)
  reply_mode TEXT,                -- text|voice|mirror (voice if customer sent voice)
  language_mode TEXT,             -- native|pivot|fixed:<lang>
  system_prompt_ref TEXT, tools TEXT[], post_steps TEXT[],   -- e.g. {summary,crm_update,cdr}
  active BOOL
)
```

Default profiles shipped with the gateway:
| Profile | Modality | Pipeline summary |
|---|---|---|
| `mesgai.chat` | text | T0 FAQ → T1 → T2 |
| `mesgai.voice_note` | voice_note | ASR+lang-detect → T0/T1/T2 reply → mirror voice/text |
| `mesgai.call_inbound` | call | CPU ASR/TTS, fast_api brain, T0 for business facts |
| `bpo.inbound_support` | call | Same as above + ticket creation + CDR + QA score post-call |
| `leads.outbound_sdr` | call | Sales script, objection handling, booking tool, CRM post-call |
| `pipeline.followup_call` | call | Deal context loaded, next-step booking, deal-stage update |
| `seo.blog_article` | job | outline T1 → draft T2 → polish T3 if money page → SEO checks |
| `social.caption` / `social.title` | text/job | T1, 5–10 variants per request, platform length rules |
| `factory.story` / `factory.script` | job | T2 (T3 premium), scene list output for AI Factory |
| `generic.auto` | any | Used when no profile is sent (external devs) → Layer 3 decides |

**Layer 3 — Content detection (inside the request)**
- **Language ID:** from ASR auto-detect (audio) or a fast text detector (text). Locked after the first confident turn of a call.
- **Intent / task classifier** (Section 4.2): within a profile, picks T0/T1/T2/T3 per turn (e.g. "opening hours?" → T0; complaint → T2/T3).
- **Risk flags:** payments, medical, legal, angry caller → raise tier or hand off to a human.

So: product declares *what kind of work* (profile), the gateway decides *how cheaply it can be done* per turn.

### 4.0.1 Language layer
- `native` (default): the model understands and replies in the customer's language directly.
- `pivot`: for languages where the chosen model is weak: translate to English → reason → translate back. Per-language quality stored in the registry (`models.lang_quality JSONB`) ⚠️ measure Urdu, Arabic, Roman Urdu, Spanish, Portuguese.
- Business can set a **working language** for its own dashboard: transcripts and summaries also stored translated for staff, while the customer always gets their own language.
- TTS voice chosen per language; if no good voice exists for a language, reply as text (never send poor-quality speech).

### 4.1 Tiers
| Tier | What | Typical use |
|---|---|---|
| **T0** | Rules, templates, DB lookups, regex, cache | Greetings, FAQ, opening hours, status checks |
| **T1** | Local small models on CPU (e.g. existing Qwen3-4B, 1–8B quantized) | Classification, extraction, short replies, rewriting, intent detection |
| **T2** | Cheap cloud models (flash/mini class) | Normal chat, summaries, content drafts |
| **T3** | Frontier models | Hard reasoning, long documents, code, high-stakes answers |

Model names and prices live **only in the registry table** (Section 6). Never hard-code them.

### 4.2 Classifier
Two-step, cheap first:
1. **Heuristics (free):** token count, presence of code, attachments, tools requested, language, conversation length, product hint (`x-kq-product`), explicit `task_type` from caller.
2. **T1 classifier (only if heuristics unsure):** local small model returns JSON:
```json
{ "task_type": "faq|extract|classify|chat|summarize|write|reason|code|translate",
  "difficulty": 0.0-1.0, "needs_tools": false, "risk": "low|medium|high" }
```
Classifier cost must stay under 5% of total spend 💲 — monitor in the ledger (`route_overhead_usd`).

### 4.3 Decision function
```ts
function chooseRoute(req: Req, cls: Classification, policy: Policy): RoutePlan {
  if (req.pin) return pinned(req.pin);

  const floor = QUALITY_FLOOR[req.quality];          // low=T0/T1 ... max=T3
  let tier = tierFor(cls.task_type, cls.difficulty); // table-driven, see routing_rules
  if (cls.risk === 'high') tier = max(tier, 'T3');
  if (cls.needs_tools && !supportsTools(tier)) tier = nextTierWithTools(tier);
  tier = max(tier, floor);

  const candidates = registry.models({ tier, task: cls.task_type, region: policy.region })
    .filter(m => m.healthy && m.maxContext >= req.tokens && withinLatency(m, req.latencyMs))
    .sort(byExpectedCost(req.tokens));               // input + output estimate, cache discounts

  return { tier, primary: candidates[0], fallbacks: candidates.slice(1, 3),
           escalateTo: nextTier(tier) };
}
```

### 4.4 Quality check & escalation
Run only on T1/T2 answers, fast and cheap:
- **Format checks:** valid JSON when JSON was requested, schema match, not empty, not truncated, language matches request.
- **Refusal / "I don't know" detection** when the task is answerable.
- **Self-consistency (optional, `quality=high`):** for extraction tasks, run twice on T1 and compare; mismatch → escalate.
- **Confidence:** if provider returns logprobs, low average → escalate.
- Max 2 escalations per request. Log every escalation (`escalations` column) — high escalation rate on a rule means the routing table is wrong.

### 4.5 Learning loop
Nightly job reads the ledger + quality results and proposes routing-table changes (e.g. "task `summarize` difficulty < 0.4 succeeded 98% on T1 → move from T2 to T1"). **Proposals only; a human approves.** Same rule as the 3D Factory evaluation gate: no automatic switch without passing the golden set (Section 13).

---

## 5. CACHE

| Layer | How | When |
|---|---|---|
| **Exact** | SHA-256 of normalized (model-class, messages, params) → Redis | Always, if `temperature ≤ 0.3` and no tools with side effects |
| **Semantic** | Embedding of last user message + system-prompt hash → pgvector similarity ≥ threshold (start 0.95 💲) | FAQ-like traffic only (task_type in faq, classify, extract) |
| **Provider prompt caching** | Keep long system prompts stable and first in the message list so provider caching applies | All T2/T3 calls; record cached tokens in ledger |

Rules:
- Cache is **per tenant**. Never serve one tenant's cached answer to another.
- TTL per task type (FAQ 7 days, extraction 30 days, chat 1 hour 💲).
- `x-kq-cache: off` respected.
- Personal data (phone, email, IDs detected) → no semantic cache.

---

## 6. MODEL & PROVIDER REGISTRY

All models, prices and limits are data, not code.

```sql
models(
  id TEXT PRIMARY KEY,                -- 'local/qwen3-4b-q4', 'provider/model-x'
  provider TEXT, tier TEXT,           -- T1|T2|T3
  modality TEXT,                      -- text|embed|asr|tts|image|video|3d
  tasks TEXT[],                       -- tasks it is approved for
  max_context INT, supports_tools BOOL, supports_json BOOL, supports_stream BOOL,
  price_in_per_mtok NUMERIC, price_out_per_mtok NUMERIC,
  price_cached_in_per_mtok NUMERIC, batch_discount NUMERIC,  -- e.g. 0.5
  price_unit TEXT, price_per_unit NUMERIC,                   -- for audio min / image / GPU-sec
  p50_latency_ms INT, healthy BOOL, regions TEXT[],
  licence TEXT, licence_ok BOOL,      -- for local/open models (same rule as 3D Factory)
  updated_at TIMESTAMPTZ
)
```
- Local models: price = measured cost (VPS cost ÷ measured throughput) 💲, recalculated weekly.
- Prices updated from a config file by an admin; a weekly job flags stale prices.
- Health: circuit breaker per model (5 errors in 60 s → unhealthy for 2 min).
- Provider API keys stored encrypted; customers can also **bring their own keys** (BYOK) per provider.

---

## 7. ASYNC / BATCH LANE

For anything that doesn't need an answer in seconds: content generation, bulk extraction, embeddings, SEO articles, transcription of recordings.

- Endpoint: `POST /v1/jobs` with `type`, `payload`, `deadline` (e.g. `"24h"`), `webhook_url`.
- BullMQ queues per lane: `batch-cheap`, `local-cpu`, `gpu`.
- Router picks: provider batch API (if `batch_discount` set and deadline allows) → local CPU overnight → normal API.
- Results stored, webhook fired, ledger row per item.
- KoneqtiSEO and BlogBot move all non-urgent generation here first (biggest internal saving 💲).

---

## 8. WORKLOAD PACKS

A pack = a tested pipeline + fixed API + measured cost per unit. Customers buy outcomes ("per call-minute", "per document"), not tokens.

### 8.1 Voice Pack (for MesgAI, BPO, Leads, Pipeline)

**HARD RULE — hybrid split (decided ✅):**
- **Ears + mouth on CPU:** VAD, ASR, TTS, audio conversion run on our servers.
- **Live brain on a fast cloud API** for real-time calls (fast time-to-first-token, cheap model class from the registry). Local CPU LLMs are too slow to read a long prompt in a live turn.
- **T0 answers instantly** for business facts (hours, prices, booking status) from the product's data.
- **Local CPU models for everything after the call or not time-critical:** summaries, CDR, lead scoring, CRM updates, follow-up messages, QA scoring, and voice-note replies.

**A) Live call flow** (`mesgai.call_inbound`, `bpo.inbound_support`, `leads.outbound_sdr`, `pipeline.followup_call`)
```
Telephony/WebRTC audio
 → VAD (CPU) → streaming ASR (CPU, lang-detect on turn 1, then locked)
 → T0 rules? ──yes──► instant answer
       │no
 → live brain (fast API, cached fixed system prompt, tools: booking/CRM lookup)
 → streaming TTS (CPU) sentence by sentence → audio out
 Barge-in: caller speaks → stop TTS immediately.
 Filler: if brain > 700 ms 💲, play short acknowledgement ("Sure, one moment").
After hang-up (async, CPU): transcript → summary → CDR row → CRM/deal update → follow-up WhatsApp via MesgAI
```
- Target: ~1 s per reply end-to-end 💲 (measure in Phase 4).
- Capacity: measure **concurrent calls per server**; autoscale by adding CPU servers.

**B) Voice-note flow** (`mesgai.voice_note`) — async, so local CPU brain is fine
```
WhatsApp audio (ogg/opus) → ffmpeg decode (CPU) → ASR + language detect (CPU)
 → T0 / T1 / T2 reply in customer's language (profile rules)
 → reply_mode: mirror → TTS (CPU) → ffmpeg to opus → send as voice note
                       or text reply
 → store transcript (+ translation in business working language)
```
- Target: reply within a few seconds 💲.

**C) Phone audio quality gate**
Before phone calls move to the gateway: word error rate per language at 8 kHz vs 16 kHz (Urdu, Arabic, English, Spanish, Roman-Urdu/English code-switching). Results in `eval_runs`.

**D) Voice cloning (owner's voice) — consent built in**
1. Consent sentence with one-time code (`GET /v1/voices/consent-sentence`).
2. Owner reads it; gateway checks with ASR that the sentence + code were spoken **and** with a speaker-verification model that the consent speaker = the sample speaker. Mismatch → `rejected`.
3. Voice bound to `subtenant_id` + verified `account_user_id`; any other subtenant → `403`.
4. Samples deleted after the voice is built; `DELETE` removes the voice completely.
5. Only cloning and speaker-verification models with `licence_ok = true` (commercial use checked by a person) ⚠️ several popular open cloning models have non-commercial weights.
6. Voice metadata `ai_generated: true`. AI-disclosure wording per country is owned by the calling product (MesgAI `country_configs`).

```sql
voices(id TEXT PRIMARY KEY, tenant_id UUID, subtenant_id UUID, account_user_id TEXT, name TEXT,
       language TEXT, model_id TEXT, status TEXT, consent_id TEXT, consent_verified BOOL,
       speaker_match_score NUMERIC, ai_generated BOOL DEFAULT true, created_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ)
voice_consents(id TEXT PRIMARY KEY, subtenant_id UUID, language TEXT, text TEXT, code TEXT,
               expires_at TIMESTAMPTZ, used BOOL DEFAULT false)
```

**E) Live translated calls** (last phase)
- Streaming ASR (`WS /v1/realtime/transcribe`) → translate on `final` phrases only (`context:"call"`; verb-final languages like Urdu/Arabic need the whole phrase) → streaming TTS (`stream:true`).
- First target: **~2 s** from end of phrase to first translated audio; tighten after measuring.
- Shared per-turn timing fields, logged by both gateway and caller per subtenant and language pair: `stt_final_ms, translate_ms, tts_first_audio_ms, total_ms`.

**Language codes:** BCP-47 everywhere. `ur-Latn` (Roman Urdu) and `hi-Latn` (Roman Hindi) are first-class languages with their own `lang_quality` entries. First translation pairs: `ur/ur-Latn↔en`, `ar↔en`, `es↔en`.
- Barge-in (caller interrupts → stop TTS).
- T0 handles greetings, hours, booking confirmations from MesgAI's business data.
- Cost unit: **per call-minute**, ledger splits ASR / LLM / TTS / telephony.
- Telephony (Twilio etc.) is a separate cost; show it separately, never hide it.
- Model choices for ASR/TTS go in the registry with licence check ⚠️ (commercial licence, languages incl. Urdu, Arabic, Spanish).

### 8.2 Document Pack (for SILK Docs, Hisaab, eInvoice)
```
File/email → OCR (CPU) → T1 extraction to JSON schema → validation rules → escalate low-confidence fields to T2/T3 → result
```
- Field-level confidence; only weak fields escalate (not the whole document).
- Supports Chinese, Arabic, Urdu, Portuguese, English ⚠️ (test OCR quality per language).
- Cost unit: **per page**.

### 8.3 Embeddings Pack
- Local CPU embedding model by default, batched.
- Cost unit: per 1k vectors. Used by semantic cache, KoneqtiSEO clustering, Leads matching.

### 8.4 Content Pack (KoneqtiSEO, BlogBot, SocialKoneqti, PinForge, AI Factory)
| Content type | Profile | Route | Lane |
|---|---|---|---|
| Blog article | `seo.blog_article` | outline T1 → draft T2 → polish T3 only for money pages | async |
| Chat reply | `mesgai.chat` | T0 → T1 → T2 | real time |
| Titles | `social.title` | T1, 5–10 variants, length rules per platform | real time or batch |
| Captions / hashtags | `social.caption` | T1, variants, platform rules | batch |
| Stories | `factory.story` | T2 (T3 premium) | async |
| Video scripts | `factory.script` | T2 → scene list JSON for AI Factory | async |
| Product descriptions | `shop.product_copy` | T1 draft → T2 if flagged | batch |
- Always via the async lane unless `urgent=true`.
- Quality checks per type: length limits, banned phrases, duplicate detection, language match.
- Cost unit: per article / per post / per script.

### 8.5 Image Pack (CPU-first) — SocialKoneqti, PinForge, BlogBot, AI Factory stills
Measured reference (FastSD CPU, MIT, Intel Core i7-12700, 512×512, OpenVINO + TAESD) ✅:
SDXS-512 ≈ 0.8 s · SD Turbo ≈ 1.7 s · SDXL Turbo ≈ 2.5 s · Hyper-SD SDXL 768×768 ≈ 6.3 s · FLUX.1-schnell ≈ 4.5 min (too slow on CPU).
On a small 4-vCPU VPS, SD-Turbo warm ≈ 20 s/image ✅ → async/batch only.
- **Tier I1 (CPU, async):** turbo/distilled models at 512–768 px → drafts, thumbnails, blog headers, Pinterest/social backgrounds. Then CPU upscale.
- **Tier I2 (cloud API, pay per image):** premium/photoreal 1024 px+, text-in-image, brand-critical.
- **Tier I3 (own rented GPU):** only when monthly I2 spend is higher than renting a GPU 💲.
- Router picks tier from `x-kq-quality` + use case. Templates + text overlays done in code (no AI) whenever possible.
- Licence check per model ⚠️ (each checkpoint has its own licence, separate from FastSD's MIT).
- Cost unit: per image.

### 8.6 Video Pack — AI Factory (Reelora / KoneqtiStudio)
Generative video on CPU is not practical today. But most marketing/product videos don't need generated footage:
- **V1 (CPU only):** script (T1/T2) + TTS (CPU) + images (Image Pack I1/I2) + motion templates, Ken Burns, transitions, captions, music → FFmpeg/Remotion assembly on CPU. Covers faceless YouTube, Shorts/Reels, slideshows, product promos.
- **V2 (cloud API, per second):** short generated clips only where a shot truly needs motion AI.
- **V3 (rented GPU lane, Section 9):** when V2 volume justifies it.
- Cost unit: per finished second; ledger shows how much was CPU vs paid generation.

### 8.7 3D Pack — 3D Factory → see Section 9 (only mesh generation needs a GPU; cleanup, retopo, UV, LOD, export run on CPU)

### 8.8 Benchmark first
Before launching any pack, run it on the actual production VPS and record results in `eval_runs`. Contabo-type shared vCPUs may be slower than the i7 figures above and may lack AVX-512 ⚠️ — a dedicated-CPU server may be the better buy.

---

## 9. GPU JOB LANE (AI FACTORY + 3D FACTORY)

Video and 3D need GPUs. We do not own GPUs. The gateway rents them per job and keeps them busy.

### 9.1 Principles
1. **Don't generate what you can reuse.** Check the asset cache first (same prompt + seed + model + settings → reuse; same product photo → reuse mesh).
2. **Draft first, final on approval.** Low-res / few-step draft → user approves → full quality render. Most jobs never need the expensive pass 💲.
3. **CPU where possible.** Script writing, TTS, captions, editing, FFmpeg assembly, Blender cleanup, retopology, UVs, format export all run on CPU/VPS. GPU only for generation steps.
4. **Batch GPU work.** Group jobs that use the same model so the model loads once per GPU session.
5. **Estimate before running.** Every job gets a cost estimate; over the tenant's limit → ask for approval.
6. **Checkpoint everything.** Rented/spot GPUs can disappear. Each step writes outputs to object storage; a restarted worker resumes from the last finished step.

### 9.2 Job graph
A job is a DAG of steps. Each step declares where it can run.

```ts
type Step = {
  id: string; kind: string;                 // 'script','tts','image_gen','video_gen','upscale','assemble','mesh_gen','retopo','uv','texture','rig','render','export'
  needs: string[];                          // step ids it depends on
  runOn: 'cpu' | 'gpu' | 'api';             // where allowed
  gpu?: { minVramGb: number; model: string };
  cacheKey?: string;                        // reuse if output exists
  draft?: boolean;                          // part of draft pass
};
```

**AI Factory example (30 s product video):**
```
script(T2, api) → voiceover(tts, cpu) → shots: image_gen(gpu, draft) ×6 → [approve]
→ video_gen(gpu, final) ×6 → upscale(gpu|cpu) → captions(cpu) → assemble(ffmpeg, cpu) → publish
```
Mixing real assets, templates and stills cuts GPU seconds (from the ChatGPT doc: a 30-second video does not need 30 seconds of fully generated footage ✅).

**3D Factory example (product photo → web asset):**
```
segment(cpu) → mesh_gen(gpu, TRELLIS.2-class) → retopo(cpu, AutoRemesher) → uv(cpu)
→ texture/bake(gpu|cpu) → LODs(cpu) → QA(cpu) → export GLB/USDZ(cpu) → preview render(cpu EEVEE / gpu)
```
Only `mesh_gen` (and optionally texture) needs a GPU. Rules from `KONEQTI_3D_FACTORY.md` and `KONEQTI_3D_HIGH_END_TRACK.md` apply (licence-clean models only, golden-set gate, correction pairs).

### 9.3 GPU workers
- Provider-agnostic worker image (Docker) with a small agent that: registers, pulls jobs for the models it has loaded, heartbeats every 10 s, uploads outputs, self-terminates after N idle minutes.
- `gpu_providers` table: provider, GPU type, VRAM, hourly price, spot/on-demand, region, API for start/stop ⚠️ (choose 1–2 rental providers; verify terms allow this use).
- Scheduler:
  - Start a GPU only when queued GPU work ≥ threshold or the oldest job waits > X min 💲.
  - Keep a worker warm while its model has queued work; stop when idle.
  - Pick the cheapest GPU type with enough VRAM for the job's model.
- Free/experimental GPU (Kaggle, Colab) **not** used for customer jobs ⚠️ (terms + reliability). Allowed for internal benchmarks only, within their terms.

### 9.4 Cost units
| Pack | Unit | Ledger breakdown |
|---|---|---|
| Video | per finished second of video | script tokens, TTS seconds, GPU seconds by step, storage |
| 3D | per accepted asset (by tier) | GPU seconds, CPU minutes, artist minutes (from 3D Factory QA) |

---

## 10. COST LEDGER & SAVINGS (THE SALES ENGINE)

Every request and job step writes one row.

```sql
usage_ledger(
  id BIGSERIAL PRIMARY KEY, tenant_id UUID, product TEXT,   -- 'mesgai','seo','aifactory','3dfactory', external
  request_id TEXT, job_id UUID NULL, step_id TEXT NULL,
  modality TEXT, task_type TEXT, tier TEXT, model_id TEXT,
  cache TEXT,                                -- hit_exact|hit_semantic|miss
  tokens_in INT, tokens_out INT, tokens_cached INT,
  units NUMERIC, unit TEXT,                  -- audio sec, pages, gpu sec, images
  cost_usd NUMERIC(12,6),                    -- what it actually cost us
  baseline_model_id TEXT, baseline_usd NUMERIC(12,6),  -- what it would cost without the gateway
  route_overhead_usd NUMERIC(12,6),          -- classifier + quality checks
  escalations SMALLINT, latency_ms INT, status TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
)
```

### 10.1 Baseline — be honest
Savings are only credible if the baseline is fair.
- **Default baseline:** the model the customer used before onboarding (declared at signup, or the model named in their request), at its public list price, no cache.
- If the customer pins a model, baseline = that model → savings only from cache/prompt caching.
- Show savings **after** subtracting `route_overhead_usd` and our fee.
- Monthly savings report per tenant: requests by tier, cache hit rate, escalation rate, actual vs baseline. This report is the marketing.

```ts
savings = sum(baseline_usd) - sum(cost_usd) - sum(route_overhead_usd)
```

---

## 11. TENANTS, KEYS, BUDGETS

- Tenants, API keys (hashed, SHA-256, prefix shown) — reuse `requireApiKey` pattern from KoneqtiLoyalty spec.
- Per-key scopes: chat, embeddings, audio, jobs, admin.
- Budgets: daily + monthly USD caps per tenant and per key; action at cap: `block` | `downgrade_tier` | `alert_only`.
- Rate limits per key (Redis token bucket).
- Internal Koneqti products = tenants with `internal=true` (no billing, full ledger).

### 11.1 Subtenants (merged from MesgAI handover ✅)
Products like MesgAI, KoneqtiLoyalty and SocialKoneqti serve many businesses. Every limit, ledger row, cache, voice and privacy rule works **per subtenant**.
- Header `x-kq-subtenant: <business_uuid>` (or `system` for calls with no business). Required for tenants with `has_subtenants=true`.
- **Tenant always comes from the API key, never from a header.** A key can only act on subtenants of its own tenant. `X-Tenant-Id` is accepted for backward compatibility but must match the key's tenant, otherwise `403`.
- Subtenants are created automatically on first use.
- Per-subtenant settings: `PUT /v1/subtenants/:id/settings` `{ "retention_days": 0, "allow_cache": true }`. `retention_days: 0` (default) = nothing kept beyond the request.
- `DELETE /v1/subtenants/:id/data` removes that business's voices, cache entries and logs.
- Per-subtenant limits → `429 { "error": { "code": "subtenant_limit" } }`; other subtenants unaffected.
- `usage_ledger`, `cache_entries`, `voices` all carry `subtenant_id`.

---

## 12. BILLING

| Plan | Price 💲 | For |
|---|---|---|
| **Free** | $0 | Up to a small monthly volume; full savings report |
| **Pay-as-you-go** | Our cost + margin per request/unit | Small builders |
| **Savings Share** | **20% of measured savings** (Section 10) + our cost | Customers with an existing AI bill — no saving, no fee |
| **Self-hosted** | Licence per server / year | Teams that must keep data on their servers |

- Stripe metered billing (same as Loyalty spec).
- Savings Share needs a baseline locked at onboarding and shown in the dashboard; disputes resolved from the ledger.
- BYOK customers pay providers directly; we bill only our fee.

---

## 13. QUALITY GATE (NO SILENT DOWNGRADES)

- **Golden sets** per task type (start with 100–300 examples each 💲) from internal products: MesgAI conversations, SEO briefs, extraction docs. Never trained on.
- Before a routing change or a new model goes live: run the golden set, compare with current route. Promote only if quality ≥ current (or within agreed tolerance) and cost lower.
- **Shadow mode:** new route answers 5% of traffic in parallel without being returned; compare.
- One-click rollback per routing rule.
- Same "measure every change" principle as the 3D Factory gates.

---

## 14. OBSERVABILITY

- OpenTelemetry traces per request (cache → classify → model → quality check).
- Prometheus metrics: requests/s by tier, cache hit rate, escalation rate, p50/p95 latency by model, error rate, GPU queue depth, GPU idle minutes, cost/hour.
- Alerts: provider down, escalation rate spike, cost/hour above threshold, GPU worker idle but billed.

---

## 15. SECURITY & PRIVACY

Follows `KONEQTI_SECURITY_STANDARD.md`. Additionally:
- Prompts/responses logged only with tenant opt-in; default = metadata only (tokens, cost, model, latency).
- PII detector before semantic cache and before sending to providers flagged `no_pii`.
- Per-tenant data region setting; route only to providers in allowed regions.
- Provider keys encrypted at rest; never returned by any API.
- GPU workers get short-lived signed URLs for inputs/outputs only.

---

## 16. DATABASE (NEW / CHANGED TABLES)

```
tenants, api_keys                     (reuse/extend existing)
models                                (Section 6)
routing_rules(id, task_type, difficulty_min, difficulty_max, tier, quality_floor, active, version)
cache_entries(id, tenant_id, key_hash, embedding vector, task_type, response JSONB, expires_at)
usage_ledger                          (Section 10)
budgets(tenant_id, key_id NULL, period, cap_usd, action)
jobs(id, tenant_id, product, type, status, deadline, estimate_usd, approved BOOL, webhook_url, created_at)
job_steps(id, job_id, kind, run_on, status, cache_key, output_uri, gpu_seconds, cost_usd, attempts)
gpu_providers(id, name, gpu_type, vram_gb, price_hour, spot BOOL, region, active)
gpu_workers(id, provider_id, status, models_loaded TEXT[], started_at, last_heartbeat, cost_usd)
golden_sets(id, task_type, input JSONB, expected JSONB, scorer)
eval_runs(id, rule_or_model, golden_set_task, quality, cost_usd, decision, created_at)
baselines(tenant_id, model_id, locked_at)
```

---

## 17. API SURFACE

| Endpoint | Notes |
|---|---|
| `POST /v1/chat/completions` | OpenAI-compatible, streaming, tools, JSON mode, routing headers |
| `POST /v1/embeddings` | Local CPU by default |
| `POST /v1/audio/transcriptions`, `/v1/audio/speech` | Voice Pack components |
| `GET /v1/models` | Includes virtual model `kq/auto` (router) and pinned models |
| `POST /v1/jobs`, `GET /v1/jobs/:id`, `POST /v1/jobs/:id/approve` | Async + GPU lanes, draft→final approval |
| `POST /v1/packs/voice/session` | Start a streaming voice session (WebSocket), requires `profile` |
| `POST /v1/audio/messages` | Voice note in → reply (text or voice note) out, async with webhook |
| `GET/POST /admin/profiles` | Manage use-case profiles; tenants can override defaults |
| `POST /v1/packs/docs/extract` | Document Pack, schema in request |
| `GET /v1/usage`, `GET /v1/savings` | Ledger summaries |
| Admin: `/admin/models`, `/admin/routing-rules`, `/admin/eval`, `/admin/gpu` | Internal dashboard |

Customer integration = set `base_url` to the gateway and `model` to `kq/auto`.

### 17.1 Additional endpoints (merged from MesgAI handover ✅)
| Endpoint | Notes |
|---|---|
| `POST /v1/audio/transcriptions` | Accepts ogg/opus, wav 8 kHz + 16 kHz (mono 16-bit), m4a, mp3, webm. Returns `{text, language, confidence, duration_sec}` |
| `POST /v1/audio/speech` | `{input, language, voice, format, speed, stream}`; formats `ogg_opus · mp3 · mulaw_8k · pcm_16k`; `stream:true` = chunked audio |
| `POST /v1/safety/classify` | `{text}` ≤ 1000 chars → `{category, score}`; must answer < 1.5 s |
| `POST /v1/translate` | `{texts[], from:"auto"|bcp47, to, context:"chat"|"call"}` → `{texts[], from_detected, confidence}` |
| `WS /v1/realtime/transcribe` | `?language&encoding=mulaw|pcm&sample_rate=8000|16000`; 20 ms binary frames in; `partial` / `final` JSON out; `{type:"end"}` closes |
| `GET /v1/voices/consent-sentence?language=` | Consent text with one-time code + `consent_id`, expires |
| `POST /v1/voices` | multipart: `consent_id, consent_audio, samples[], account_user_id, name` → `{voice_id, status: processing|ready|rejected, reason}` |
| `GET /v1/voices`, `GET/DELETE /v1/voices/:id` | Only the calling subtenant's voices; delete removes all samples |
| `GET /v1/usage?subtenant=&from=&to=` | Per-subtenant totals by task (calls, tokens, audio_sec); no subtenant = tenant totals |
| `PUT /v1/subtenants/:id/settings`, `DELETE /v1/subtenants/:id/data` | Section 11.1 |

### 17.2 Header contract (all endpoints)
| Request header | Values | Note |
|---|---|---|
| `Authorization` | `Bearer <key>` | Tenant derived from key |
| `x-kq-subtenant` | business UUID · `system` | Section 11.1 |
| `x-kq-profile` | e.g. `mesgai.chat` | Preferred way to declare use case |
| `X-Task` | `reply · classify.intent · extract.order · summary` | **Legacy alias**, mapped to profiles: `reply→mesgai.chat`, `summary→mesgai.summary`, `classify.intent→mesgai.classify`, `extract.order→mesgai.extract_order` |
| `x-kq-priority` | `realtime · normal · batch` (default `normal`) | Section 3.1 |
| `X-Request-Id` | caller trace id | Returned in response, never stored with content |

| Response header | Meaning |
|---|---|
| `x-kq-model` (alias `X-Model-Used`) | Model that answered |
| `x-kq-usage-tokens` | Input + output tokens (text) |
| `x-kq-usage-audio-sec` | Audio seconds (transcription: input · speech: output) |
| `x-kq-cost-usd`, `x-kq-baseline-usd`, `x-kq-cache`, `x-kq-tier` | Section 3 |
| `Retry-After` | With `503` |

| Error | Meaning |
|---|---|
| `503` + `Retry-After` | Busy; **realtime pool full returns 503 immediately, never queues** |
| `429 subtenant_limit` | That business is over its limit |
| `401/403` | Bad key, wrong tenant, or another subtenant's voice |
| `400` | Bad request |

---

## 18. DASHBOARD (NEXT.JS)

1. **Savings overview** — this month: actual vs baseline, % saved, cache hit rate, requests by tier (stacked bar), top products.
2. **Requests explorer** — filter by product, tier, model, cache, escalations; open a trace.
3. **Routing rules** — table editor, versioned, with "run golden set" button and rollback.
4. **Models & providers** — registry, health, prices, licence status.
5. **Jobs** — queue, draft approvals, cost estimates, GPU seconds per step.
6. **GPU fleet** — active workers, idle cost, queue depth.
7. **Budgets & keys** — caps, actions, key scopes.
8. **Billing** — plan, savings share calculation, invoices.

---

## 19. KONEQTI PRODUCT INTEGRATION

| Product | Uses | First change |
|---|---|---|
| **MesgAI** | Voice Pack, chat router, T0 FAQ from business data | Switch WhatsApp replies to `kq/auto` |
| **KoneqtiSEO / BlogBot** | Content Pack, async lane, embeddings | Move bulk generation to `/v1/jobs` with 24 h deadline |
| **SocialKoneqti / PinForge** | Content Pack | Captions/titles on T1 |
| **Koneqti Leads / Pipeline** | Extraction, classification, personalization | Lead scoring on T1 |
| **KoneqtiLoyalty** | WhatsApp message drafting (templates mostly T0) | Template fill via T0 |
| **SILK Docs / Hisaab / eInvoice** | Document Pack | Per-page extraction |
| **AI Factory (Reelora / KoneqtiStudio)** | Video Pack + GPU lane | Draft→final flow, asset cache |
| **3D Factory** | 3D Pack + GPU lane | `mesh_gen` on rented GPU, rest on CPU |

Every product sends `x-kq-product: <name>` so the ledger shows savings per product.

---

## 20. ROLLOUT PHASES

| Phase | Scope | Exit criteria |
|---|---|---|
| **0** | Audit existing gateway (Section 0) | `GATEWAY_AUDIT.md` approved |
| **1** | Registry, ledger with baseline, budgets, OpenAI-compatible endpoint, exact cache, routing headers | All internal products can call `kq/auto`; ledger correct on 100 test requests |
| **2** | Classifier, tiered router, quality check + escalation, semantic cache, golden sets for 3 task types | Internal savings measured for 2 weeks; quality ≥ baseline on golden sets |
| **3** | Async/batch lane + Content Pack; move KoneqtiSEO/BlogBot | Bulk jobs complete within deadline; cost per article measured |
| **1b** | MesgAI handover Parts 1–2: subtenants, priority pools, usage headers, audio formats + duration, privacy settings, TTS formats, voice cloning with consent | MesgAI fake-gateway tests + one real run per endpoint pass (incl. a rejected mismatched-speaker clone) |
| **4** | Voice Pack + Document Pack; MesgAI Part 3 (translate) then Part 4 (live translated calls) | MesgAI test calls meet latency target; 8 kHz WER report; doc extraction field accuracy measured |
| **5** | GPU job lane, job graph, draft→final, asset cache; AI Factory + 3D Factory integration | One video and one 3D asset end to end with ledger breakdown |
| **6** | External launch: signup, dashboard, Stripe, savings report, docs | First 10 external tenants with savings reports |
| **7** | Self-hosted package, BYOK, routing learning-loop proposals | Paying self-hosted customer |

Do not start Phase 6 until Phase 2 shows real internal savings numbers.

---

## 21. CLAUDE.md RULES (ADD TO REPO)

```
## KONEQTI GATEWAY RULES
- Never break existing gateway endpoints; new behaviour behind feature flags.
- Every Koneqti product sends `x-kq-profile`; requests without one use `generic.auto`.
- Tenant comes from the API key only. Subtenant from `x-kq-subtenant`, scoped to that tenant. Never mix subtenant data (cache, voices, logs, usage).
- Realtime priority uses its own reserved workers; full pool → 503 immediately, never queue.
- Audio deleted right after processing; message text never logged unless the subtenant's retention setting allows it.
- No voice clone without verified consent sentence + speaker match.
- Live calls: ASR/TTS/VAD on CPU, brain on fast API (profile.live_brain = fast_api). Never a local CPU LLM in the live turn.
- Customers always get replies in their own language; no TTS reply in a language without an approved voice (fall back to text).
- Model names, prices, tiers and limits live in the `models` table / config only.
- Every request and job step writes a usage_ledger row with cost_usd AND baseline_usd.
- Never serve cached data across tenants. No semantic cache when PII is detected.
- `x-kq-route: pin:<model>` always bypasses the router.
- No routing rule or model change goes live without a golden-set eval run.
- Max 2 escalations per request; log each one.
- GPU workers: checkpoint every step; self-terminate when idle; no free/experimental GPUs for customer jobs.
- Only licence-checked models for local inference (licence_ok = true).
- Telephony and other pass-through costs shown separately, never hidden in "AI cost".
- Do not claim savings in UI or marketing that the ledger cannot reproduce.
```

---

## 22. OPEN CHECKS

1. Current state of the existing gateway code (Phase 0 audit).
2. Which cloud providers/models to start with, and their batch + prompt-cache pricing ⚠️ (enter in registry, don't trust old numbers).
3. ASR/TTS models with commercial licences and Urdu/Arabic/Spanish/Portuguese quality ⚠️.
4. OCR quality for Chinese/Arabic/Urdu documents ⚠️.
5. GPU rental providers: price, spot behaviour, API, terms of use ⚠️.
6. VPS capacity: how many concurrent T1 requests the current CPU handles (benchmark) 💲.
7. Legal wording for Savings Share contracts (baseline definition, disputes) ⚠️.
8. Competitor check before external launch: OpenRouter, Portkey, LiteLLM, Martian, Not Diamond, Helicone ⚠️ (features and pricing change often).
