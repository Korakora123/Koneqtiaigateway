#!/usr/bin/env bash
# Acceptance 9: no outbound calls to external AI providers.
#  1. Source scan: no external AI provider hosts / SDKs anywhere in the repo code.
#  2. Runtime: ollama/speech/tts containers (internal network) cannot reach the internet.
set -uo pipefail
cd "$(dirname "$0")/.."
PROJECT=${COMPOSE_PROJECT_NAME:-ai-gateway}
fail=0

echo "== source scan"
PATTERN='api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis|api\.deepseek|api\.groq\.com|openrouter\.ai|api\.mistral\.ai|api\.cohere|api\.together|@anthropic-ai/sdk|"openai"|from openai|import openai|google-generativeai'
if grep -rEn "$PATTERN" gateway/src services sdk --include='*.ts' --include='*.js' --include='*.mjs' --include='*.py' --include='*.json' --include='*.txt' \
     --exclude-dir=node_modules --exclude-dir=tests --exclude-dir=test 2>/dev/null; then
  echo "  !! external AI provider reference found"; fail=1
else
  echo "  ok: none"
fi

echo "== runtime egress (expect every attempt to FAIL)"
for svc in ollama speech tts; do
  cid=$(docker ps -q --filter "label=com.docker.compose.project=${PROJECT}" --filter "label=com.docker.compose.service=${svc}" | head -1)
  [ -z "$cid" ] && { echo "  $svc: not running (skipped)"; continue; }
  for host in api.openai.com api.anthropic.com 1.1.1.1; do
    if docker run --rm --network "container:${cid}" busybox:1.36 timeout 5 wget -q -T 4 -O /dev/null "https://${host}" >/dev/null 2>&1 \
       || docker run --rm --network "container:${cid}" busybox:1.36 timeout 5 nc -z -w 4 "$host" 443 >/dev/null 2>&1; then
      echo "  !! $svc CAN reach $host"; fail=1
    else
      echo "  ok: $svc cannot reach $host"
    fi
  done
done
[ "$fail" -eq 0 ] && echo "PASS" || { echo "FAIL"; exit 1; }
