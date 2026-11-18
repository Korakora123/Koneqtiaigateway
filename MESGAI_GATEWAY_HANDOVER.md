# MesgAI → Koneqti AI Gateway — Handover
**For:** the gateway Claude Code session (read together with `KONEQTI_GATEWAY_MASTER.md`)
**From:** MesgAI (brain on VPS2) · November 2026 · status: agreed list, formats proposed

`KONEQTI_GATEWAY_MASTER.md` is the source of truth. This file says what MesgAI needs, with exact formats.
Anything here that the spec does not have yet is listed in **Section 7**. Send that part back to be merged
into the spec, so there is one source of truth.

**Order:** Part 1 and Part 2 now · Part 3 next · Part 4 last.

---

## 0. Who is calling

MesgAI is **one gateway customer** (tenant `mesgai`) with **hundreds of businesses** inside it. Every limit,
ledger line, privacy rule and data separation must work **per business**, so every call carries a subtenant.

### Request headers (every endpoint)
| Header | Value | Required |
|---|---|---|
| `Authorization` | `Bearer {AI_GATEWAY_KEY}` | yes |
| `X-Tenant-Id` | `mesgai` | yes |
| `x-kq-subtenant` | the MesgAI business id (UUID), e.g. `3f2c…-…` | yes for business calls · `system` for calls with no business (admin tools, system prompts) |
| `X-Task` | `reply` · `classify.intent` · `extract.order` · `summary` | chat only |
| `x-kq-priority` | `realtime` (live phone call) · `normal` (chat reply, voice note) · `batch` (summaries, broadcasts, reports) | yes (default `normal`) |
| `X-Request-Id` | MesgAI's id for this call (for tracing; not stored with content) | optional |

### Response headers (every endpoint)
| Header | Meaning |
|---|---|
| `X-Model-Used` | model that answered |
| `x-kq-usage-tokens` | tokens used by this call (input + output) — text endpoints |
| `x-kq-usage-audio-sec` | seconds of audio — transcription: input seconds · speech: output seconds |
| `Retry-After` | seconds, with 503 |

### Errors
| Code | Meaning | What MesgAI does |
|---|---|---|
| `503` + `Retry-After` | busy | chat: holding reply in the customer's language + owner's inbox · safety: keyword filter decides · call: falls back to the turn-by-turn call flow |
| `429` `{ "error": { "code": "subtenant_limit" } }` | this **business** is over its limit | owner told "Action needed"; other businesses unaffected |
| `401` / `403` | bad key / not allowed (e.g. someone else's voice) | logged, no retry |
| `400` | bad request | logged, no retry |

---

## 1. Small things — now

### 1.1 Chat — `POST /v1/chat/completions` (exists)
Standard OpenAI body. `model` is ignored; the gateway picks it by `X-Task`.
```json
{ "model": "auto",
  "messages": [ { "role": "system", "content": "…" }, { "role": "user", "content": "…" } ],
  "max_tokens": 250, "temperature": 0.4, "stream": false }
```
MesgAI keeps the context ≤ 900 tokens (business facts + 3-sentence summary + last 5 messages).
Response: standard OpenAI `choices[0].message.content` + the headers above.

### 1.2 Voice note → text — `POST /v1/audio/transcriptions` (exists; add formats + duration)
`multipart/form-data`:
| Field | Value |
|---|---|
| `file` | audio |
| `language` | optional ISO hint (`ur`, `ar`, `en`, `es`, `hi` …) |

Must accept:
- WhatsApp voice notes: `audio/ogg` (Opus)
- phone audio: `audio/wav` at **8 kHz** (mono, 16-bit) and 16 kHz
- `audio/mp4` / `m4a`, `audio/mpeg`, `audio/webm`

Response:
```json
{ "text": "…", "language": "ur", "confidence": 0.91, "duration_sec": 7.4 }
```
**8 kHz test (before MesgAI moves phone calls to the gateway):** many speech models are built for 16 kHz.
The gateway resamples, but phone-audio accuracy is tested separately. Use a test set of real-sounding phone audio in
**Urdu, Arabic, English, Spanish** (and Roman-Urdu speakers code-switching with English). Report the word error
rate per language at 8 kHz vs 16 kHz.

### 1.3 Safety — `POST /v1/safety/classify` (exists)
`{ "text": "…" }` (≤ 1000 chars) → `{ "category": "none|self_harm|medical_emergency|threat|…", "score": 0.0–1.0 }`.
MesgAI waits 1.5 s at most; on timeout or 503 the keyword filter decides.

### 1.4 Priority — more than queue order
- `realtime` runs on its **own reserved CPU workers**. A live call never waits behind a batch of chat replies.
- When the reserved pool is full, answer `503` **at once** (short `Retry-After`), don't queue. The call falls back to
  the turn-by-turn flow; a caller can't wait.
- `batch` may wait; it must never take the reserved workers.
- Time budgets MesgAI uses: realtime turn ≈ 2 s · reply 25 s · safety 1.5 s · transcription 60 s.

### 1.5 Usage per business
- Every response carries `x-kq-usage-tokens` / `x-kq-usage-audio-sec`. MesgAI writes them to its own ledger per
  business (plans have monthly AI-reply limits).
- The gateway keeps the same ledger per `x-kq-subtenant`:
  `GET /v1/usage?subtenant=<business_id>&from=2026-11-01&to=2026-11-30` →
  ```json
  { "subtenant": "…", "by_task": { "reply": { "calls": 812, "tokens": 402311 },
    "transcription": { "calls": 96, "audio_sec": 1840.2 } } }
  ```
  `subtenant` omitted → totals for the whole tenant.

### 1.6 Privacy — per business
- Default (from the spec): log **metadata only** (time, task, model, tokens/seconds, status) — never message text.
- **Audio is deleted right after processing** (transcription, cloning samples after training, speech output).
- **Per-business retention setting:**
  `PUT /v1/subtenants/<business_id>/settings` `{ "retention_days": 0, "allow_cache": true }` →
  `{ "ok": true }` · `retention_days: 0` = nothing kept beyond the request (default).
- **Delete a business:** `DELETE /v1/subtenants/<business_id>/data` → removes its voices, cache, logs; `{ "ok": true }`.
- Data separation: caches, voices and logs are keyed by subtenant; one business never gets another's data.

---

## 2. Speaking and voice cloning — now

Moves the owner's-voice engine off MesgAI's server (it is a model; models live in the gateway).

### 2.1 Text → speech — `POST /v1/audio/speech`
```json
{ "input": "Aap ka order kal tak pohanch jayega.", "language": "ur",
  "voice": "v_9a1c…",            // a cloned voice of THIS business, or a stock voice id
  "format": "ogg_opus",          // ogg_opus (WhatsApp voice note) · mp3 · mulaw_8k (phone) · pcm_16k
  "speed": 1.0 }
```
Response: audio bytes, `Content-Type` per format, `x-kq-usage-audio-sec`.
`403` if `voice` belongs to another business.
(Azure stays the stock voice for live calls until Part 4.)

### 2.2 Voice cloning — consent built in from day one
1. **Get a consent sentence:** `GET /v1/voices/consent-sentence?language=ur` →
   `{ "consent_id": "c_…", "text": "Main, <name>, MesgAI ko apni awaaz istemal karne ki ijazat deta hoon. Code 4817.", "expires_at": "…" }`
   The sentence has a one-time code, so an old recording can't be reused.
2. **Create the voice:** `POST /v1/voices` (`multipart/form-data`)
   | Field | Value |
   |---|---|
   | `consent_id` | from step 1 |
   | `consent_audio` | the owner reading the sentence |
   | `samples[]` | 1–10 clips of the same person (30 s – 5 min total) |
   | `account_user_id` | the verified MesgAI account (owner) creating it |
   | `name` | label, e.g. "Safdar — Urdu" |

   Gateway checks: the consent audio says the sentence (code included) **and** the consent speaker = the sample
   speaker (speaker check). Otherwise `rejected`. Nobody can clone someone from an uploaded clip.
   → `{ "voice_id": "v_…", "status": "processing" | "ready" | "rejected", "reason": null }`
3. `GET /v1/voices/<voice_id>` → status · `GET /v1/voices` → this business's voices only ·
   `DELETE /v1/voices/<voice_id>` → deletes the voice and every sample.
- A voice is linked to its subtenant and the verified account. Use by any other subtenant → `403`.
- **Licence check:** several popular open voice-cloning models have non-commercial weights. Every model in the
  registry carries `license_commercial: true` (checked by a person) before it can serve MesgAI.
- **AI disclosure:** some countries require telling callers they're talking to an AI. MesgAI owns this as a
  per-country setting (its `country_configs` table) and speaks the notice in the greeting. The gateway adds
  `ai_generated: true` to each voice's metadata so other products can do the same.

---

## 3. Translation — next

`POST /v1/translate`
```json
{ "texts": [ "Kya aap kal delivery kar sakte hain?" ], "from": "auto", "to": "en",
  "context": "chat" }            // chat (inbox) · call (live call phrase)
```
→
```json
{ "texts": [ "Can you deliver tomorrow?" ], "from_detected": "ur-Latn", "confidence": 0.88 }
```
- Maps onto the gateway's existing language layer. Short inbox messages run on cheap local CPU models with a cache.
- Cache is keyed by subtenant (no shared cache across businesses), and follows `allow_cache`.
- **Language codes:** BCP-47. MesgAI maps its own names: `urdu → ur`, `roman_urdu → ur-Latn`, `arabic → ar`
  (dialects `ar-EG`, `ar-SA`, `ar-AE` …), `english → en`, `spanish → es`, `hindi → hi`, `roman_hindi → hi-Latn`.
  **Roman Urdu (`ur-Latn`) is a first-class language** — a large share of MesgAI customers write it.
- First pairs: `ur/ur-Latn ↔ en`, `ar ↔ en`, `es ↔ en`.

---

## 4. Live translated calls — last

Spec on the MesgAI side: `MESGAI_AMENDMENT_02_LIVE_TRANSLATED_CALLS.md`.

### 4.1 Live speech → text — `WS /v1/realtime/transcribe?language=ur&encoding=mulaw&sample_rate=8000`
Headers as in Section 0 (`x-kq-priority: realtime`). Client sends binary audio frames (20 ms each).
Server sends:
```json
{ "type": "partial", "text": "kal delivery", "start_ms": 1200 }
{ "type": "final", "text": "Kya aap kal delivery kar sakte hain?", "language": "ur", "start_ms": 1200, "end_ms": 3900 }
```
`final` = a phrase ended (a pause). Client sends `{ "type": "end" }` to close.

### 4.2 Live text → speech — `POST /v1/audio/speech` with `"stream": true`
Same body as 2.1; audio comes back in chunks (chunked transfer) so the first audio plays before the sentence is done.

### 4.3 Translate per phrase
Translate on `final` phrases (`/v1/translate`, `context: "call"`), not word by word: Urdu and Arabic put the verb at
the end, so the system has to wait for the phrase.

### 4.4 Speed target
- **First target: about 2 seconds** from the end of a phrase until the other side starts hearing the translation
  (human interpreters lag 2–3 s). Measure, then tighten.
- MesgAI logs per turn: `stt_final_ms`, `translate_ms`, `tts_first_audio_ms`, `total_ms`, per language pair.
  The gateway reports the same per subtenant, so both sides read the same numbers.

---

## 5. What MesgAI changes on its side (after the gateway confirms)
1. `X-Tenant-Id: mesgai` + `x-kq-subtenant: <business id>` (today MesgAI sends the business id as `X-Tenant-Id`).
2. Sends `x-kq-priority` (calls `realtime`, chat `normal`, summaries `batch`).
3. Reads `x-kq-usage-*` into its per-business ledger.
4. Live-call transcription passes the business id (today it is missing — fix ready).
5. Voice-note replies in the owner's voice move to `/v1/audio/speech`; the local `voice-engine/` is removed.
6. Maps its language names to BCP-47 (Section 3).
7. AI disclosure per country in `country_configs`.

## 6. How MesgAI checks it works
- Fake-gateway unit tests in the brain for every format here.
- Then one real run per endpoint against the gateway: reply, voice note (ogg), phone audio (8 kHz wav), safety,
  speech (ogg_opus), voice cloning with consent (and one rejected try with a mismatched speaker), translate.

## 7. Possibly not in `KONEQTI_GATEWAY_MASTER.md` yet — please check and send back
MesgAI has not seen the spec file itself. The gateway session should mark which of these are new:
- `x-kq-priority` values `realtime | normal | batch`, and instant `503` when the realtime pool is full
- `429` with `code: "subtenant_limit"`
- `duration_sec` in the transcription response; 8 kHz phone-audio accuracy test per language
- `GET /v1/usage` per subtenant
- `PUT /v1/subtenants/<id>/settings` (`retention_days`, `allow_cache`) and `DELETE /v1/subtenants/<id>/data`
- `/v1/audio/speech` formats `ogg_opus | mp3 | mulaw_8k | pcm_16k`, and `stream: true`
- Voice cloning: consent sentence with one-time code, speaker check, `license_commercial` registry field,
  `ai_generated` voice metadata
- `/v1/translate` body (`texts[]`, `from: auto`, `context`), BCP-47 codes incl. `ur-Latn` / `hi-Latn`
- `WS /v1/realtime/transcribe` messages (`partial` / `final`)
- Shared per-turn timing fields for live calls
