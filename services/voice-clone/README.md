# voice-clone (Chatterbox) — DISABLED until Stage 2 (GPU)

This is where `mesgai-brain/voice-engine/` (Chatterbox) moves to (spec §2, build step 4).
It is **not** started in Stage 0: no service in `docker-compose.yml`, and the gateway answers
`PUT/GET/DELETE /v1/voices/{business_id}` with `501 not_available_until_gpu`.

## Moving the code (owner / next session with access to mesgai-brain)
1. Copy `mesgai-brain/voice-engine/*` into this folder (keep its licence file).
2. Replace its language table with `language_map.py` from this folder — it adds
   **arabic (`ar`)** and **turkish (`tr`)**, as the spec asks.
3. Do **not** add it to `docker-compose.yml` for Stage 0. Stage 2 adds a `voice-clone`
   service under the `stage2` profile, on the GPU server.

## Stage 2 requirements (before enabling)
- Consent record per business voice (who, when, what it may be used for).
- Voice samples encrypted at rest; `DELETE /v1/voices/{business_id}` really deletes samples and embeddings.
- Chatterbox Multilingual licence re-checked (MIT at time of writing) — never XTTS-v2, F5-TTS
  weights, Meta MMS-TTS or Fish Speech weights.
- Set `VOICE_CLONE_ENABLED=true` on the gateway only after the above pass.
