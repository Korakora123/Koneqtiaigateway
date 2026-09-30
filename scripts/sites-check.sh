#!/usr/bin/env bash
# Acceptance 1: CloudPanel sites respond within normal time while the AI is under load.
# Usage: SITE_URLS="https://site1 https://site2 https://site3" scripts/sites-check.sh [rounds]
# Run once idle (baseline) and once during `node bench/run.js --load` and compare.
set -uo pipefail
ROUNDS=${1:-5}
[ -z "${SITE_URLS:-}" ] && { echo 'set SITE_URLS="https://a https://b https://c"'; exit 1; }
for url in $SITE_URLS; do
  times=()
  for _ in $(seq "$ROUNDS"); do
    t=$(curl -s -o /dev/null -w '%{http_code} %{time_total}' --max-time 20 "$url")
    times+=("$t"); sleep 1
  done
  echo "$url  ${times[*]}"
done
