# DEPLOY.md — Stage 0 on the shared CloudPanel VPS

Target: Linux VPS, 6 vCPU / 12 GB, CloudPanel with live WordPress sites.
Everything below either **adds new files** or runs **inside Docker**. Nothing touches
CloudPanel, MySQL, PHP-FPM, existing sites or existing nginx configs.

> Owner approval needed before step 1 (installing Docker, if it isn't there) and step 2 (swap file).
> Both are one-time host changes. Everything else is containers + new files.

---

## 0. Before you start
```bash
free -h; nproc; df -h /                 # need ~15 GB free disk (images + models)
docker --version && docker compose version   # Docker Engine 24+ with compose v2
stat -fc %T /sys/fs/cgroup              # cgroup2fs = cgroup v2 (recommended)
```
Write down 3 site URLs for the spot-checks, and the **public IP of the Windows VPS**.

## 1. Docker (only if missing — owner approval)
Install Docker Engine from docker.com's official repo for your distro. Do not upgrade the OS.

## 2. Swap safety net (owner approval, spec §4.5)
```bash
swapon --show                           # skip if a swap file already exists
sudo fallocate -l 4G /swapfile-ai && sudo chmod 600 /swapfile-ai
sudo mkswap /swapfile-ai && sudo swapon /swapfile-ai
echo '/swapfile-ai none swap sw 0 0' | sudo tee -a /etc/fstab
sudo sysctl vm.swappiness=10            # swap only as a last resort
```

## 3. Get the code
```bash
sudo mkdir -p /opt/koneqti && sudo chown $USER /opt/koneqti
git clone <repo-url> /opt/koneqti/ai-gateway && cd /opt/koneqti/ai-gateway
```

## 4. Keys and .env
```bash
cp .env.example .env && chmod 600 .env
# one key per product; give the KEY to the product, put only the HASH in .env
docker run --rm -v "$PWD/gateway/scripts:/s" node:22-bookworm-slim node /s/gen-key.mjs mesgai
docker run --rm -v "$PWD/gateway/scripts:/s" node:22-bookworm-slim node /s/gen-key.mjs tokofy
docker run --rm -v "$PWD/gateway/scripts:/s" node:22-bookworm-slim node /s/gen-key.mjs bench
```
Edit `.env`:
- `PRODUCT_KEYS='{"mesgai":"<hash>","tokofy":"<hash>","bench":"<hash>"}'`
- `ALLOWED_IPS=127.0.0.1,172.31.87.1,<WINDOWS_VPS_IP>`
- `TZ=` your server's timezone (off-peak window uses it), `OFFPEAK_WINDOW=01:00-07:00`
- If `172.31.87.0/24` is already used by another docker network (`docker network ls`,
  `ip route`), change `AI_EDGE_SUBNET` and the two `172.31.87.1` entries.

## 5. Download models and voices (one time; the only step with internet access)
```bash
docker compose build
docker compose --profile setup run --rm ollama-setup     # qwen3:4b (~2.6 GB)
docker compose --profile setup run --rm speech-setup     # faster-whisper small (~500 MB)
docker compose --profile setup run --rm tts-setup        # Piper voices + MODEL_CARDs
```
`tts-setup` prints each voice's licence lines and fails if a voice name no longer exists
(it lists the alternatives). **Read every MODEL_CARD** (in the `tts_voices` volume), then set
`licence_checked: true` in `config/tts_languages.yaml`, or disable that language.

## 6. Start with limits
```bash
docker compose up -d
docker compose ps                      # all healthy after ~1 min
scripts/check-limits.sh                # acceptance 2: totals 3.5 CPU / 6064 MB, oom_score_adj 800
curl -s http://127.0.0.1:8787/health | head -c 600; echo
```
Optional better CPU sharing under the same 3.5 CPU / 6 GB cap (see `docker-compose.slice.yml`):
```bash
sudo cp ops/systemd/koneqti-ai.slice /etc/systemd/system/ && sudo systemctl daemon-reload
sudo systemctl start koneqti-ai.slice
docker compose -f docker-compose.yml -f docker-compose.slice.yml up -d
scripts/check-limits.sh                # verifies the slice quota/memory
```

## 7. Smoke test on the server
```bash
KEY=<bench key>
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H 'X-Tenant-Id: smoke' -H 'X-Task: reply' \
  -H 'Content-Type: application/json' -D - \
  -d '{"messages":[{"role":"system","content":"Reply in Roman Urdu, one sentence."},{"role":"user","content":"Assalam o alaikum, kal plumber aa sakta hai?"}]}'
# expect 200, X-Model-Used: qwen3-4b, X-Queue-Ms, X-Usage, X-Request-Id
docker compose logs gateway | tail -3  # metadata only — no message text
```

## 8. Expose privately to the Windows VPS (pick ONE)
**A. nginx — new file only**
```bash
sudo cp ops/nginx/koneqti-ai-gateway.conf /etc/nginx/sites-enabled/koneqti-ai-gateway.conf
sudo nano /etc/nginx/sites-enabled/koneqti-ai-gateway.conf   # server_name, cert paths, allow <WINDOWS_VPS_IP>
sudo nginx -t && sudo systemctl reload nginx                  # never restart
```
Open port 8443 in the firewall **for the Windows VPS IP only**.
CloudPanel may keep its nginx vhosts elsewhere — check with `nginx -T | grep -n "include"`
and put the file in a directory that is already included, without editing any existing file.

**B. Cloudflare Tunnel** — `ops/cloudflared/config.example.yml`, protected by Cloudflare Access.

## 9. Acceptance checks (spec §13) — record results in STATUS.md
| # | How |
|---|---|
| 1 | `SITE_URLS="https://a https://b https://c" scripts/sites-check.sh` idle, then again during step 10's load test |
| 2 | `scripts/check-limits.sh --watch` during the load test |
| 3 | `scripts/memory-pressure-test.sh speech` |
| 4 | step 7 + `docker compose logs gateway` shows no text |
| 5 | `AI_GATEWAY_KEY=<bench key> npm --prefix evals run eval -- --only extract` (json_validity = 1) |
| 6 | send a real (consented) Urdu voice note to `/v1/audio/transcriptions` → `language`, `confidence` |
| 7 | load test below: overflow gets `503` + `Retry-After`, `errors: 0` |
| 8 | covered by gateway tests (`npm --prefix gateway test`); optional: send a `summary` task during a load test and watch it wait in `/health` queues |
| 9 | `scripts/egress-check.sh` |
| 10 | step 10 writes STATUS.md |

## 10. Benchmark + load test
Needs Node 20+ on a machine that can reach the gateway, or run it in a throwaway container:
```bash
docker run --rm --network host -v "$PWD:/w" -w /w -e AI_GATEWAY_KEY=<bench key> node:22-bookworm-slim \
  node bench/run.js                                   # eval rate → capacity → STATUS.md
docker run --rm --network host -v "$PWD:/w" -w /w -e AI_GATEWAY_KEY=<bench key> \
  -e SITE_URLS="https://a https://b https://c" node:22-bookworm-slim \
  node bench/run.js --load 6 --duration 180           # p95 + site times under load
```
Spec §4.9 alert thresholds: host RAM > 85 %, site slowdown, p95 reply > 20 s.

## 11. Monitoring (Uptime Kuma)
Add monitors (Kuma can run anywhere that reaches these URLs):
- HTTP(s) – Keyword: `https://ai.example.com:8443/health`, keyword `"ok":true`
  (Kuma's IP must be in the nginx allow list and `ALLOWED_IPS`), interval 60 s.
- HTTP(s) – Keyword: `"alerts":[]` on the same URL → warns on `host_ram_above_85pct`,
  `reply_p95_above_20s`, `speech_down`, `tts_down`.
- One HTTP monitor per CloudPanel site (response-time alert above its normal baseline).
Prometheus can scrape `/metrics` (same allowlist).

## 12. Operations
```bash
docker compose ps / logs -f gateway / restart gateway
docker compose pull ollama && docker compose up -d ollama    # after pinning OLLAMA_IMAGE
docker compose down                                           # stops AI; volumes (models, usage) are kept
```
Usage DB: volume `ai-gateway_gateway_data` (`usage.db`, metadata only, pruned after
`USAGE_RETENTION_DAYS`). Back it up with `docker run --rm -v ai-gateway_gateway_data:/d -v $PWD:/b busybox cp /d/usage.db /b/`.
**Never** `docker compose down -v` without the owner's approval — it deletes the models and usage data.

## 13. MesgAI cutover (spec §10)
In the brain's env: `AI_GATEWAY_URL=https://ai.example.com:8443`, `AI_GATEWAY_KEY=<mesgai key>`,
`USE_AI_GATEWAY=true` (keep the old `OLLAMA_URL`/`WHISPER_URL`/… until verified). Use
`sdk/` (`@koneqti/ai`): on `BusyError` send the reviewed holding reply; for safety, fall back to
the keyword filter. After a week without problems stop Ollama/Whisper on the Windows VPS.
